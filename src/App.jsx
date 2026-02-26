// src/App.jsx - Aplicação integrada otimizada
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useOptimizedAudioCapture } from './useOptimizedAudioCapture';
import { useSmartCache } from './useSmartCache';
import { useParallelQueue } from './useParallelQueue';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { api } from './api';

// Componentes
function MetricsBar({ metrics, cost, cacheStats, latency }) {
  return (
    <div className="metrics-bar">
      <div className="metric">
        <span className="metric-value">{latency}ms</span>
        <span className="metric-label">Latency</span>
      </div>
      <div className="metric">
        <span className="metric-value">${cost.toFixed(3)}</span>
        <span className="metric-label">Session</span>
      </div>
      <div className="metric">
        <span className="metric-value">{cacheStats.memoryItems}</span>
        <span className="metric-label">Cached</span>
      </div>
      <div className="metric">
        <span className="metric-value">{(metrics.bytesSent / 1024).toFixed(0)}KB</span>
        <span className="metric-label">Audio</span>
      </div>
    </div>
  );
}

function QACard({ qa, isExpanded, onToggle, isStarred, onStar }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(qa.answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`qa-card ${qa.cached ? 'cached' : ''} ${isStarred ? 'starred' : ''}`}>
      <div className="qa-header" onClick={onToggle}>
        <span className="qa-num">#{qa.id}</span>
        <span className="qa-q">{qa.question.slice(0, 60)}...</span>
        <div className="qa-badges">
          {qa.cached && <span className="badge cache">CACHE</span>}
          {qa.processingTimeMs > 0 && (
            <span className="badge time">{qa.processingTimeMs}ms</span>
          )}
          <button onClick={(e) => { e.stopPropagation(); onStar(); }}>
            {isStarred ? '★' : '☆'}
          </button>
          <span>{isExpanded ? '▼' : '▶'}</span>
        </div>
      </div>
      
      {isExpanded && (
        <div className="qa-body">
          <div className="qa-section">
            <strong>Q:</strong> {qa.question}
          </div>
          <div className="qa-section answer">
            <div className="answer-header">
              <strong>A:</strong>
              <button onClick={copy} className={copied ? 'copied' : ''}>
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            <div className="markdown-body">
              {qa.answer.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            {qa.cost && <span className="cost-tag">Cost: ${qa.cost}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  // Estados
  const [sessionId, setSessionId] = useState(null);
  const [active, setActive] = useState(false);
  const [qaList, setQaList] = useState([]);
  const [starred, setStarred] = useState(new Set());
  const [currentQ, setCurrentQ] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [source, setSource] = useState('microphone');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [stealth, setStealth] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [lastLatency, setLastLatency] = useState(0);

  // Refs
  const idCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStart = useRef(0);

  // Hooks otimizados
  const { getCached, setCached, getStats: getCacheStats } = useSmartCache();
  
  const processQuestion = useCallback(async (question, metadata) => {
    const start = performance.now();
    
    // Verifica cache primeiro
    const cached = getCached(question);
    if (cached) {
      const qa = {
        id: ++idCounter.current,
        question,
        answer: cached.answer,
        processingTimeMs: 0,
        cached: true,
        cost: 0,
        timestamp: Date.now()
      };
      setQaList(prev => [...prev, qa]);
      setExpanded(qa.id);
      setLastLatency(performance.now() - start);
      return;
    }

    // Chama API
    setIsGenerating(true);
    try {
      const previous = qaList.slice(-3).map(q => ({ 
        question: q.question, 
        answer: q.answer.slice(0, 200) 
      }));
      
      const result = await api.answer(question, sessionId, previous, false);
      
      // Salva no cache
      setCached(question, result.answer, {
        tokens: result.tokens?.output,
        processingTime: result.processingTimeMs,
        cost: parseFloat(result.cost)
      });

      const qa = {
        id: ++idCounter.current,
        question,
        answer: result.answer,
        processingTimeMs: result.processingTimeMs,
        cached: false,
        cost: result.cost,
        tokens: result.tokens,
        timestamp: Date.now()
      };

      setQaList(prev => [...prev, qa]);
      setExpanded(qa.id);
      setSessionCost(c => c + parseFloat(result.cost || 0));
      setLastLatency(performance.now() - start);
      
    } catch (err) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  }, [getCached, setCached, qaList, sessionId]);

  const { add: queueQuestion, getStats: getQueueStats } = useParallelQueue(processQuestion, {
    maxConcurrent: 1, // GPT é sequencial por sessão
    debounceMs: 300
  });

  // Audio capture otimizado
  const handleAudioChunk = useCallback(async (base64, mimeType, size, estimatedDuration) => {
    if (!active) return;
    
    setIsTranscribing(true);
    const start = performance.now();
    
    try {
      const result = await api.transcribe(base64, mimeType, 'en', estimatedDuration);
      setIsTranscribing(false);
      setLastLatency(Math.round(performance.now() - start));
      
      if (!result.text || result.text.trim().length < 5) return;
      
      const question = result.text.trim();
      setCurrentQ(question);
      
      // Adiciona à fila (com debounce e dedup)
      queueQuestion({ question }, { estimatedCost: result.estimatedCost });
      setCurrentQ('');
      
    } catch (err) {
      setIsTranscribing(false);
      setError(err.message.slice(0, 100));
    }
  }, [active, queueQuestion]);

  const { 
    status: audioStatus, 
    error: audioError, 
    metrics: audioMetrics,
    startRecording, 
    pause, 
    resume, 
    stop 
  } = useOptimizedAudioCapture({ 
    onChunk: handleAudioChunk,
    silenceThreshold: 800,
    maxChunkMs: 10000
  });

  // Timer
  useEffect(() => {
    if (active && audioStatus === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - sessionStart.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [active, audioStatus]);

  // Scroll
  useEffect(() => {
    if (scrollRef.current && !stealth) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [qaList, currentQ, isGenerating, stealth]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onTogglePause: () => audioStatus === 'recording' ? pause() : resume(),
    onStop: () => stopSession(),
    onToggleStealth: () => setStealth(s => !s),
    isActive: active,
    captureStatus: audioStatus
  });

  // Session controls
  const startSession = async (src) => {
    try {
      setStarting(true);
      setSource(src);
      const session = await api.createSession();
      setSessionId(session.id);
      setActive(true);
      setQaList([]);
      setSessionCost(0);
      setElapsed(0);
      sessionStart.current = Date.now();
      idCounter.current = 0;
      await startRecording(src);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const stopSession = async () => {
    stop();
    setActive(false);
    setStealth(false);
    if (sessionId) {
      try { await api.endSession(sessionId, qaList.length); } catch (e) {}
    }
  };

  const exportSession = async () => {
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/session/${sessionId}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `interview-${sessionId}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Export failed');
    }
  };

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const cacheStats = getCacheStats();

  // Stealth mode
  if (stealth && active) {
    return (
      <div className="stealth-mode">
        <div className="stealth-widget">
          <div className={`status-dot ${audioStatus === 'recording' ? 'recording' : 'paused'}`} />
          <span className="stealth-timer">{formatTime(elapsed)}</span>
          <span className="stealth-count">{qaList.length}Q</span>
          <span className="stealth-cost">${sessionCost.toFixed(2)}</span>
          <button onClick={() => audioStatus === 'recording' ? pause() : resume()}>
            {audioStatus === 'recording' ? '⏸' : '▶'}
          </button>
          <button onClick={() => setStealth(false)}>⛶</button>
          <button onClick={stopSession}>⏹</button>
        </div>
        {currentQ && <div className="stealth-q">{currentQ}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Interview Agent <span className="version">v2.0</span></h1>
        {active && (
          <div className="header-stats">
            <span className="timer">{formatTime(elapsed)}</span>
            <button className="stealth-btn" onClick={() => setStealth(true)} title="Stealth (Ctrl+H)">
              👁
            </button>
          </div>
        )}
      </header>

      <main className="app-main" ref={scrollRef}>
        {!active ? (
          <div className="start-screen">
            <h2>Optimized for Speed & Cost</h2>
            <p>Mono audio • Smart caching • Parallel processing</p>
            
            <div className="source-grid">
              <button onClick={() => startSession('system')} disabled={starting} className="btn-primary">
                <span className="icon">🖥</span>
                <span>System Audio</span>
                <small>Zoom, Meet, Teams</small>
              </button>
              
              <button onClick={() => startSession('microphone')} disabled={starting} className="btn-secondary">
                <span className="icon">🎤</span>
                <span>Microphone</span>
                <small>Ambient audio</small>
              </button>
            </div>

            <div className="shortcuts">
              <kbd>Ctrl</kbd><kbd>Space</kbd> Pause/Resume
              <kbd>Ctrl</kbd><kbd>H</kbd> Stealth
              <kbd>Esc</kbd> Stop
            </div>

            <MetricsBar 
              metrics={audioMetrics} 
              cost={sessionCost} 
              cacheStats={cacheStats}
              latency={lastLatency}
            />
          </div>
        ) : (
          <div className="session-active">
            <div className="qa-container">
              {qaList.length === 0 && !currentQ && !isTranscribing && (
                <div className="waiting">Waiting for questions...</div>
              )}

              {qaList.map(qa => (
                <QACard
                  key={qa.id}
                  qa={qa}
                  isExpanded={expanded === qa.id}
                  onToggle={() => setExpanded(expanded === qa.id ? null : qa.id)}
                  isStarred={starred.has(qa.id)}
                  onStar={() => setStarred(s => {
                    const next = new Set(s);
                    next.has(qa.id) ? next.delete(qa.id) : next.add(qa.id);
                    return next;
                  })}
                />
              ))}

              {(isTranscribing || currentQ || isGenerating) && (
                <div className="processing">
                  {isTranscribing && <span>🎤 Transcribing...</span>}
                  {currentQ && <span className="preview">Q: {currentQ}</span>}
                  {isGenerating && <span>🤖 Generating... {getQueueStats().queueLength > 0 && `(+${getQueueStats().queueLength})`}</span>}
                </div>
              )}
            </div>

            <div className="control-bar">
              <div className={`status ${audioStatus}`}>
                {audioStatus === 'recording' && <span className="pulse"></span>}
                {audioStatus}
              </div>
              
              <div className="actions">
                {audioStatus === 'recording' ? (
                  <button onClick={pause}>⏸ Pause</button>
                ) : (
                  <button onClick={resume}>▶ Resume</button>
                )}
                <button onClick={exportSession} disabled={qaList.length === 0}>💾 Export</button>
                <button onClick={() => setStealth(true)}>👁 Stealth</button>
                <button onClick={stopSession} className="danger">⏹ Stop</button>
              </div>
            </div>

            <MetricsBar 
              metrics={audioMetrics} 
              cost={sessionCost} 
              cacheStats={cacheStats}
              latency={lastLatency}
            />
          </div>
        )}
      </main>

      {(error || audioError) && (
        <div className="toast error" onClick={() => setError(null)}>
          {error || audioError}
        </div>
      )}
    </div>
  );
}
