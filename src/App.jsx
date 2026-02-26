// src/App.jsx - Aplicação principal completa
import { useState, useCallback, useEffect, useRef } from 'react';
import { useOptimizedAudioCapture } from './useOptimizedAudioCapture';
import { useSmartCache } from './useSmartCache';
import { useParallelQueue } from './useParallelQueue';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { JobProfileManager } from './components/JobProfileManager';
import { QACard } from './components/QACard';
import { api } from './api';

// Metrics Panel Component
function MetricsPanel({ metrics, cost, cacheStats, latency, tailored }) {
  return (
    <div className="metrics-panel">
      <div className="metric-group">
        <div className="metric">
          <span className="metric-value">{latency}ms</span>
          <span className="metric-label">Last Latency</span>
        </div>
        <div className="metric">
          <span className="metric-value">${cost.toFixed(3)}</span>
          <span className="metric-label">Session Cost</span>
        </div>
        <div className="metric">
          <span className="metric-value">{cacheStats.memoryItems + cacheStats.storageItems}</span>
          <span className="metric-label">Cached</span>
        </div>
        <div className="metric">
          <span className="metric-value">{cacheStats.hitRate}%</span>
          <span className="metric-label">Cache Hit</span>
        </div>
      </div>
      
      <div className="metric-group secondary">
        <div className="metric">
          <span className="metric-value">{(metrics.bytesSent / 1024).toFixed(0)}KB</span>
          <span className="metric-label">Audio Sent</span>
        </div>
        <div className="metric">
          <span className="metric-value">{metrics.chunksSent}</span>
          <span className="metric-label">Chunks</span>
        </div>
        {tailored !== null && (
          <div className={`metric ${tailored ? 'tailored' : ''}`}>
            <span className="metric-value">{tailored ? '✓' : '○'}</span>
            <span className="metric-label">{tailored ? 'Tailored' : 'Generic'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Stealth Mode Component
function StealthMode({ status, elapsed, qaCount, cost, currentQ, onPause, onResume, onStop, onExpand }) {
  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  return (
    <div className="stealth-container">
      <div className="stealth-widget">
        <div className={`status-indicator ${status}`} />
        <span className="stealth-timer">{formatTime(elapsed)}</span>
        <span className="stealth-count">{qaCount}Q</span>
        <span className="stealth-cost">${cost.toFixed(2)}</span>
        
        <div className="stealth-controls">
          <button onClick={status === 'recording' ? onPause : onResume}>
            {status === 'recording' ? '⏸' : '▶'}
          </button>
          <button onClick={onExpand} title="Expand">⛶</button>
          <button onClick={onStop} className="danger" title="Stop">⏹</button>
        </div>
      </div>
      
      {currentQ && (
        <div className="stealth-question">
          <span className="label">Detected:</span>
          <span className="text">{currentQ}</span>
        </div>
      )}
    </div>
  );
}

// Main App
export default function App() {
  // Estados principais
  const [sessionId, setSessionId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [qaList, setQaList] = useState([]);
  const [starredIds, setStarredIds] = useState(new Set());
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedQA, setExpandedQA] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [audioSource, setAudioSource] = useState('microphone');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [stealthMode, setStealthMode] = useState(false);
  const [showJobManager, setShowJobManager] = useState(false);
  
  // Job context
  const [selectedJob, setSelectedJob] = useState(null);
  const [lastTailored, setLastTailored] = useState(null);
  
  // Métricas
  const [sessionCost, setSessionCost] = useState(0);
  const [lastLatency, setLastLatency] = useState(0);

  // Refs
  const qaIdCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStartRef = useRef(0);

  // Hooks otimizados
  const { getCached, setCached, getStats: getCacheStats } = useSmartCache();

  // Carrega job default na montagem
  useEffect(() => {
    api.getDefaultJob().then(job => {
      if (job) setSelectedJob(job);
    });
  }, []);

  // Processamento de pergunta
  const processQuestion = useCallback(async (question, metadata) => {
    const start = performance.now();
    
    // Verifica cache
    const cached = getCached(question);
    if (cached) {
      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer: cached.answer,
        processingTimeMs: 0,
        cached: true,
        tailored: false,
        cost: 0,
        timestamp: Date.now()
      };
      
      setQaList(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setLastTailored(false);
      setLastLatency(Math.round(performance.now() - start));
      return;
    }

    setIsGenerating(true);
    try {
      const previousQAs = qaList.slice(-3).map(qa => ({
        question: qa.question,
        answer: qa.answer.slice(0, 200)
      }));

      const result = await api.answer(question, sessionId, previousQAs);
      
      // Salva no cache
      setCached(question, result.answer, {
        tokens: result.tokens?.output,
        processingTime: result.processingTimeMs,
        cost: parseFloat(result.cost)
      });

      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer: result.answer,
        processingTimeMs: result.processingTimeMs,
        cached: false,
        tailored: result.tailored,
        cost: result.cost,
        tokens: result.tokens,
        timestamp: Date.now()
      };

      setQaList(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setSessionCost(c => c + parseFloat(result.cost || 0));
      setLastTailored(result.tailored);
      setLastLatency(Math.round(performance.now() - start));
      
    } catch (err) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  }, [getCached, setCached, qaList, sessionId]);

  // Fila paralela com debounce
  const { add: queueQuestion, getStats: getQueueStats } = useParallelQueue(processQuestion, {
    maxConcurrent: 1,
    debounceMs: 250
  });

  // Captura de áudio otimizada
  const handleAudioChunk = useCallback(async (base64, mimeType, size, estimatedDuration) => {
    if (!sessionActive) return;
    
    setIsTranscribing(true);
    const start = performance.now();
    
    try {
      const result = await api.transcribe(base64, mimeType, 'en', estimatedDuration);
      setIsTranscribing(false);
      
      if (!result.text || result.text.trim().length < 5) return;
      
      const question = result.text.trim();
      setCurrentTranscription(question);
      
      // Adiciona à fila
      queueQuestion({ question }, { estimatedCost: result.estimatedCost });
      setCurrentTranscription('');
      
    } catch (err) {
      setIsTranscribing(false);
      setError(err.message.slice(0, 100));
    }
  }, [sessionActive, queueQuestion]);

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
    maxChunkMs: 12000,
    minChunkMs: 3000
  });

  // Timer
  useEffect(() => {
    if (sessionActive && audioStatus === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - sessionStartRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [sessionActive, audioStatus]);

  // Scroll automático
  useEffect(() => {
    if (scrollRef.current && !stealthMode) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [qaList, currentTranscription, isGenerating, stealthMode]);

  // Atalhos de teclado
  useKeyboardShortcuts({
    onTogglePause: () => audioStatus === 'recording' ? pause() : resume(),
    onStop: stopSession,
    onToggleStealth: () => setStealthMode(s => !s),
    isActive: sessionActive,
    captureStatus: audioStatus
  });

  // Controles de sessão
  const startSession = async (source) => {
    try {
      setStarting(true);
      setAudioSource(source);
      
      const session = await api.createSession(selectedJob?.id);
      setSessionId(session.id);
      setSessionActive(true);
      setQaList([]);
      setSessionCost(0);
      setElapsedTime(0);
      setLastTailored(null);
      sessionStartRef.current = Date.now();
      qaIdCounter.current = 0;
      
      // Atualiza job se veio da sessão
      if (session.jobName) {
        setSelectedJob({
          id: session.jobProfileId,
          name: session.jobName,
          company: session.company,
          key_skills: session.key_skills,
          seniority: session.seniority
        });
      }
      
      await startRecording(source);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const stopSession = async () => {
    stop();
    setSessionActive(false);
    setStealthMode(false);
    
    if (sessionId) {
      try {
        await api.endSession(sessionId, qaList.length);
      } catch (e) {
        console.warn('Failed to end session:', e);
      }
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
      a.download = `interview-${sessionId}-${new Date().toISOString().split('T')[0]}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Export failed: ' + err.message);
    }
  };

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const cacheStats = getCacheStats();

  // Render modo stealth
  if (stealthMode && sessionActive) {
    return (
      <StealthMode
        status={audioStatus}
        elapsed={elapsedTime}
        qaCount={qaList.length}
        cost={sessionCost}
        currentQ={currentTranscription}
        onPause={pause}
        onResume={resume}
        onStop={stopSession}
        onExpand={() => setStealthMode(false)}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>Interview Agent <span className="version">v2.0</span></h1>
        </div>
        
        <div className="header-center">
          {selectedJob ? (
            <div 
              className="job-indicator" 
              onClick={() => setShowJobManager(true)}
              title="Click to change"
            >
              <span className="job-name">{selectedJob.name}</span>
              {selectedJob.company && (
                <span className="job-company">at {selectedJob.company}</span>
              )}
              <span className="job-seniority">{selectedJob.seniority}</span>
            </div>
          ) : (
            <button 
              className="btn-select-job" 
              onClick={() => setShowJobManager(true)}
            >
              + Select Job Profile
            </button>
          )}
        </div>
        
        <div className="header-right">
          {sessionActive && (
            <>
              <span className="header-timer">{formatTime(elapsedTime)}</span>
              <button 
                className="btn-stealth" 
                onClick={() => setStealthMode(true)}
                title="Stealth Mode (Ctrl+H)"
              >
                👁
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-main" ref={scrollRef}>
        {!sessionActive ? (
          <div className="start-screen">
            <div className="hero">
              <h2>AI-Powered Interview Assistant</h2>
              <p className="subtitle">
                Optimized for <strong>speed</strong>, <strong>cost</strong>, and <strong>relevance</strong>
              </p>
              <ul className="features">
                <li>🎯 Job-specific tailored responses</li>
                <li>⚡ Smart caching (60%+ cost reduction)</li>
                <li>🎤 Optimized audio (mono 16kHz, silence detection)</li>
                <li>📊 Real-time cost tracking</li>
              </ul>
            </div>

            <div className="source-selection">
              <button 
                onClick={() => startSession('system')} 
                disabled={starting || !selectedJob}
                className="btn-source primary"
              >
                <span className="icon">🖥</span>
                <span className="label">System Audio</span>
                <span className="hint">Zoom, Meet, Teams</span>
              </button>
              
              <button 
                onClick={() => startSession('microphone')} 
                disabled={starting || !selectedJob}
                className="btn-source secondary"
              >
                <span className="icon">🎤</span>
                <span className="label">Microphone</span>
                <span className="hint">Ambient audio</span>
              </button>
            </div>

            {!selectedJob && (
              <div className="warning">
                ⚠️ Please select or create a Job Profile first
              </div>
            )}

            <div className="shortcuts-hint">
              <kbd>Ctrl</kbd><kbd>Space</kbd> Pause/Resume
              <kbd>Ctrl</kbd><kbd>H</kbd> Stealth Mode
              <kbd>Esc</kbd> Stop Session
            </div>

            <MetricsPanel
              metrics={audioMetrics}
              cost={sessionCost}
              cacheStats={cacheStats}
              latency={lastLatency}
              tailored={null}
            />
          </div>
        ) : (
          <div className="session-active">
            <div className="qa-list">
              {qaList.length === 0 && !currentTranscription && !isTranscribing && (
                <div className="waiting-state">
                  <p>Listening for questions...</p>
                  <span className="hint">
                    {audioSource === 'system' ? 'Capturing system audio' : 'Capturing microphone'}
                  </span>
                </div>
              )}

              {qaList.map(qa => (
                <QACard
                  key={qa.id}
                  qa={qa}
                  isExpanded={expandedQA === qa.id}
                  onToggle={() => setExpandedQA(expandedQA === qa.id ? null : qa.id)}
                  isStarred={starredIds.has(qa.id)}
                  onStar={() => {
                    setStarredIds(prev => {
                      const next = new Set(prev);
                      next.has(qa.id) ? next.delete(qa.id) : next.add(qa.id);
                      return next;
                    });
                  }}
                />
              ))}

              {(isTranscribing || currentTranscription || isGenerating) && (
                <div className="processing-state">
                  {isTranscribing && (
                    <div className="processing-item">
                      <span className="spinner">🎤</span>
                      <span>Transcribing...</span>
                    </div>
                  )}
                  {currentTranscription && (
                    <div className="processing-item preview">
                      <span className="label">Detected:</span>
                      <span className="text">{currentTranscription}</span>
                    </div>
                  )}
                  {isGenerating && (
                    <div className="processing-item">
                      <span className="spinner">🤖</span>
                      <span>
                        Generating... 
                        {getQueueStats().queueLength > 0 && ` (+${getQueueStats().queueLength})`}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="control-bar">
              <div className={`status-badge ${audioStatus}`}>
                <span className={`pulse ${audioStatus === 'recording' ? 'active' : ''}`} />
                <span>{audioStatus}</span>
              </div>

              <div className="control-actions">
                {audioStatus === 'recording' ? (
                  <button onClick={pause} className="btn-control">⏸ Pause</button>
                ) : (
                  <button onClick={resume} className="btn-control">▶ Resume</button>
                )}
                <button 
                  onClick={exportSession} 
                  disabled={qaList.length === 0}
                  className="btn-control"
                >
                  💾 Export
                </button>
                <button 
                  onClick={() => setStealthMode(true)} 
                  className="btn-control"
                >
                  👁 Stealth
                </button>
                <button onClick={stopSession} className="btn-control danger">
                  ⏹ Stop
                </button>
              </div>
            </div>

            <MetricsPanel
              metrics={audioMetrics}
              cost={sessionCost}
              cacheStats={cacheStats}
              latency={lastLatency}
              tailored={lastTailored}
            />
          </div>
        )}
      </main>

      {showJobManager && (
        <div className="modal-overlay" onClick={() => setShowJobManager(false)}>
          <div className="modal large" onClick={e => e.stopPropagation()}>
            <JobProfileManager
              selectedId={selectedJob?.id}
              onSelect={(job) => {
                setSelectedJob(job);
                setShowJobManager(false);
              }}
              onClose={() => setShowJobManager(false)}
            />
          </div>
        </div>
      )}

      {(error || audioError) && (
        <div className="toast error" onClick={() => setError(null)}>
          {error || audioError}
        </div>
      )}
    </div>
  );
}
