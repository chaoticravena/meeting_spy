// src/App.jsx - Versão melhorada completa
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useAudioCapture } from './useAudioCapture';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useLocalCache } from './useLocalCache';
import { QACard } from './components/QACard';
import { StealthWidget } from './components/StealthWidget';
import { api } from './api';

export default function App() {
  // Estados principais
  const [sessionId, setSessionId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [qaPairs, setQaPairs] = useState([]);
  const [starredIds, setStarredIds] = useState(new Set());
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedQA, setExpandedQA] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [audioSource, setAudioSource] = useState('microphone');
  const [starting, setStarting] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [stealthMode, setStealthMode] = useState(false);

  // Refs
  const qaIdCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStartRef = useRef(0);

  // Cache local
  const { getCached, setCached } = useLocalCache();

  // Toast auto-dismiss
  useEffect(() => {
    if (toastMsg) {
      const t = setTimeout(() => setToastMsg(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toastMsg]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current && !stealthMode) {
      scrollRef.current.scrollTo({ 
        top: scrollRef.current.scrollHeight, 
        behavior: 'smooth' 
      });
    }
  }, [qaPairs, currentTranscription, isGenerating, stealthMode]);

  // Timer
  useEffect(() => {
    if (sessionActive && captureStatus === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - sessionStartRef.current) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [sessionActive, captureStatus]);

  // Processamento de áudio com cache
  const handleAudioChunk = useCallback(async (audioBase64, mimeType) => {
    if (!sessionActive) return;
    
    setIsTranscribing(true);
    try {
      const result = await api.transcribe(audioBase64, mimeType, 'pt');
      
      if (!result.text || result.text.trim().length < 3) {
        setIsTranscribing(false);
        return;
      }

      const question = result.text.trim();
      setCurrentTranscription(question);
      setIsTranscribing(false);
      setIsGenerating(true);

      // Verifica cache primeiro
      const cached = getCached(question);
      let answer, processingTimeMs, fromCache;

      if (cached) {
        answer = cached.answer;
        processingTimeMs = 0;
        fromCache = true;
      } else {
        const previousQAs = qaPairs.slice(-5).map(qa => ({ 
          question: qa.question, 
          answer: qa.answer 
        }));
        
        const aiResult = await api.answer(question, sessionId, previousQAs);
        answer = aiResult.answer;
        processingTimeMs = aiResult.processingTimeMs;
        fromCache = false;
        
        // Salva no cache
        setCached(question, answer);
      }

      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer,
        processingTimeMs,
        cached: fromCache,
        timestamp: Date.now(),
      };

      setQaPairs(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setCurrentTranscription('');
      
      // Notificação sutil se estiver em modo discreto
      if (stealthMode && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Nova resposta pronta!', { 
          body: question.slice(0, 50) + '...',
          silent: true 
        });
      }
      
    } catch (err) {
      console.error('Processing error:', err);
      if (err?.message && !err.message.includes('empty')) {
        setToastMsg(err.message.slice(0, 100));
      }
    } finally {
      setIsTranscribing(false);
      setIsGenerating(false);
    }
  }, [sessionActive, sessionId, qaPairs, stealthMode, getCached, setCached]);

  // Audio capture hook
  const { 
    status: captureStatus, 
    error: captureError, 
    startRecording, 
    pause, 
    resume, 
    stop 
  } = useAudioCapture({ 
    chunkIntervalMs: 10000, 
    onChunk: handleAudioChunk 
  });

  // Controles de sessão
  const handleStart = useCallback(async (source) => {
    try {
      setStarting(true);
      setAudioSource(source);
      
      // Solicita permissão para notificações silenciosas
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      
      const session = await api.createSession();
      setSessionId(session.id);
      setSessionActive(true);
      setQaPairs([]);
      setElapsedTime(0);
      sessionStartRef.current = Date.now();
      qaIdCounter.current = 0;
      
      await startRecording(source);
    } catch (err) {
      setToastMsg(err.message);
    } finally {
      setStarting(false);
    }
  }, [startRecording]);

  const handleStop = useCallback(async () => {
    stop();
    setSessionActive(false);
    setStealthMode(false);
    
    if (sessionId) {
      try { 
        await api.endSession(sessionId, qaPairs.length); 
      } catch (e) { 
        console.warn(e); 
      }
    }
  }, [stop, sessionId, qaPairs.length]);

  const togglePause = useCallback(() => {
    if (captureStatus === 'recording') {
      pause();
    } else if (captureStatus === 'paused') {
      resume();
    }
  }, [captureStatus, pause, resume]);

  // Atalhos de teclado
  useKeyboardShortcuts({
    onTogglePause: togglePause,
    onStop: handleStop,
    onToggleStealth: () => setStealthMode(prev => !prev),
    isActive: sessionActive,
    captureStatus
  });

  // Toggle favorito
  const toggleStar = useCallback((id) => {
    setStarredIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Formatação de tempo
  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  // Status para UI
  const statusConfig = useMemo(() => {
    if (!sessionActive) return { label: 'Pronto', color: 'bg-gray-500', pulse: false };
    if (isGenerating) return { label: 'Gerando...', color: 'bg-amber-500', pulse: true };
    if (isTranscribing) return { label: 'Transcrevendo...', color: 'bg-blue-500', pulse: true };
    if (captureStatus === 'recording') return { label: 'Gravando', color: 'bg-emerald-500', pulse: true };
    if (captureStatus === 'paused') return { label: 'Pausado', color: 'bg-amber-500', pulse: false };
    return { label: 'Pronto', color: 'bg-gray-500', pulse: false };
  }, [sessionActive, isGenerating, isTranscribing, captureStatus]);

  // Exportar sessão
  const exportSession = useCallback(() => {
    const markdown = `# Entrevista - ${new Date().toLocaleString()}

**Duração:** ${formatTime(elapsedTime)}
**Perguntas:** ${qaPairs.length}

${qaPairs.map((qa, i) => `
## ${i + 1}. ${qa.question}

${qa.answer}

${qa.cached ? '*[Resposta do cache]*' : ''}
---
`).join('')}`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `entrevista-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [qaPairs, elapsedTime]);

  // Render modo stealth
  if (stealthMode && sessionActive) {
    return (
      <StealthWidget
        status={isGenerating ? 'processing' : captureStatus}
        elapsedTime={elapsedTime}
        qaCount={qaPairs.length}
        currentTranscription={currentTranscription}
        onTogglePause={togglePause}
        onStop={handleStop}
        onExpand={() => setStealthMode(false)}
      />
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <h1>Interview Agent</h1>
        
        {sessionActive && (
          <div className="session-info">
            <span className="timer">{formatTime(elapsedTime)}</span>
            <span className="badge">{qaPairs.length} Qs</span>
            <button onClick={() => setStealthMode(true)} className="stealth-btn" title="Modo discreto (Ctrl+H)">
              👁
            </button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="app-main" ref={scrollRef}>
        {!sessionActive ? (
          <div className="start-screen">
            <h2>Assistente de Entrevista</h2>
            <p>Captura áudio, transcreve e gera respostas técnicas em tempo real.</p>
            
            <div className="source-buttons">
              <button 
                onClick={() => handleStart('system')} 
                disabled={starting}
                className="btn-primary"
              >
                🖥 Áudio do Sistema
                <small>Zoom, Meet, Teams</small>
              </button>
              
              <button 
                onClick={() => handleStart('microphone')} 
                disabled={starting}
                className="btn-secondary"
              >
                🎤 Microfone
                <small>Áudio ambiente</small>
              </button>
            </div>
            
            <div className="shortcuts-hint">
              <kbd>Ctrl</kbd>+<kbd>Space</kbd> Pausar/Retomar &nbsp;
              <kbd>Ctrl</kbd>+<kbd>H</kbd> Modo discreto &nbsp;
              <kbd>Esc</kbd> Encerrar
            </div>
          </div>
        ) : (
          <div className="session-screen">
            {/* Q&A List */}
            <div className="qa-list">
              {qaPairs.length === 0 && !currentTranscription && !isTranscribing && (
                <div className="waiting">
                  <p>Aguardando perguntas...</p>
                  <small>{audioSource === 'system' ? 'Capturando áudio do sistema' : 'Capturando áudio do microfone'}</small>
                </div>
              )}

              {qaPairs.map(qa => (
                <QACard
                  key={qa.id}
                  qa={qa}
                  isExpanded={expandedQA === qa.id}
                  onToggle={() => setExpandedQA(expandedQA === qa.id ? null : qa.id)}
                  onStar={() => toggleStar(qa.id)}
                  isStarred={starredIds.has(qa.id)}
                />
              ))}

              {(isTranscribing || currentTranscription || isGenerating) && (
                <div className="processing-card">
                  {isTranscribing && <div className="pulse">🎤 Transcrevendo...</div>}
                  {currentTranscription && (
                    <div className="transcription-preview">
                      <strong>Detectado:</strong> {currentTranscription}
                    </div>
                  )}
                  {isGenerating && <div className="pulse">🤖 Gerando resposta...</div>}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="controls-bar">
              <div className={`status-indicator ${statusConfig.color} ${statusConfig.pulse ? 'pulse' : ''}`}>
                {statusConfig.label}
              </div>
              
              <div className="control-buttons">
                {captureStatus === 'recording' && (
                  <button onClick={pause} className="btn-control">⏸ Pausar</button>
                )}
                {captureStatus === 'paused' && (
                  <button onClick={resume} className="btn-control">▶ Retomar</button>
                )}
                <button onClick={exportSession} className="btn-control" disabled={qaPairs.length === 0}>
                  💾 Exportar
                </button>
                <button onClick={() => setStealthMode(true)} className="btn-control stealth">
                  👁 Discreto
                </button>
                <button onClick={handleStop} className="btn-control danger">⏹ Encerrar</button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Toast/Error */}
      {(captureError || toastMsg) && (
        <div className="toast error">
          {captureError || toastMsg}
        </div>
      )}
    </div>
  );
}
