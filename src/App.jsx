import { useState, useCallback, useEffect, useRef } from 'react';
import { useOptimizedAudioCapture } from './useOptimizedAudioCapture';
import { useParallelQueue } from './useParallelQueue';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { JobProfileManager } from './components/JobProfileManager';
import { QACard } from './components/QACard';
import { api } from './api';

// --- Componentes Auxiliares (Mantidos) ---

// Metrics Panel Component
function MetricsPanel({ metrics, cost, cacheStats, latency, tailored }) {
  // Simplificado para usar apenas métricas relevantes para a nova arquitetura
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
          <span className="metric-value">{cacheStats.hits}</span>
          <span className="metric-label">Cache Hits</span>
        </div>
        <div className="metric">
          <span className="metric-value">{cacheStats.misses}</span>
          <span className="metric-label">Cache Misses</span>
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

// --- Main App ---
export default function App() {
  // Estados principais
  const [sessionId, setSessionId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [qaList, setQaList] = useState([]);
  const [starredIds, setStarredIds] = useState(new Set());
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState(null); // Novo estado para streaming
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
  const [cacheStats, setCacheStats] = useState({ hits: 0, misses: 0 }); // Simplificado
  
  // Refs
  const qaIdCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStartRef = useRef(0);
  const abortControllerRef = useRef(null); // Para cancelar o streaming

  // Carrega job default na montagem
  useEffect(() => {
    api.getDefaultJob().then(job => {
      if (job) setSelectedJob(job);
    });
  }, []);

  // Processamento de pergunta (Agora com Streaming)
  const processQuestion = useCallback(async (question) => {
    const start = performance.now();
    
    // 1. Prepara contexto (Last 3 Q&A)
    const previousQAs = qaList.slice(-3).map(qa => ({
      question: qa.question,
      answer: qa.answer.slice(0, 200) // Limita o tamanho do contexto
    }));

    // 2. Inicia o Streaming
    setIsGenerating(true);
    setCurrentAnswer({
      id: ++qaIdCounter.current,
      question,
      answer: '',
      isStreaming: true,
      timestamp: Date.now()
    });
    
    // Cancela stream anterior se houver
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    let fullAnswer = '';
    let finalResult = {};

    try {
      for await (const chunk of api.streamAnswer(question, sessionId, previousQAs)) {
        if (chunk.type === 'content') {
          fullAnswer += chunk.content;
          setCurrentAnswer(prev => ({
            ...prev,
            answer: fullAnswer,
          }));
        } else if (chunk.type === 'done') {
          finalResult = chunk;
          break;
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message);
        }
      }

      // 3. Finaliza e salva a resposta
      const newQA = {
        id: qaIdCounter.current,
        question,
        answer: fullAnswer,
        processingTimeMs: Math.round(performance.now() - start),
        cached: finalResult.usage.cached,
        tailored: finalResult.tailored,
        cost: finalResult.cost,
        tokens: finalResult.usage.tokens,
        timestamp: Date.now()
      };

      setQaList(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setCurrentAnswer(null); // Limpa o estado de streaming
      
      // 4. Atualiza Métricas
      setSessionCost(c => c + parseFloat(finalResult.cost || 0));
      setLastTailored(finalResult.tailored);
      setLastLatency(newQA.processingTimeMs);
      
      // Atualiza Cache Stats (simulado, idealmente viria do backend)
      setCacheStats(prev => ({
        hits: prev.hits + (finalResult.usage.cached ? 1 : 0),
        misses: prev.misses + (finalResult.usage.cached ? 0 : 1),
      }));
      
    } catch (err) {
      setError(err.message);
      setCurrentAnswer(null);
    } finally {
      setIsGenerating(false);
    }
  }, [qaList, sessionId]);

  // Fila paralela com debounce (Mantida)
  const { add: queueQuestion, getStats: getQueueStats } = useParallelQueue(processQuestion, {
    maxConcurrent: 1,
    debounceMs: 250
  });

  // Captura de áudio otimizada (Atualizada)
  const handleAudioChunk = useCallback(async (base64, mimeType, estimatedDuration) => {
    if (!sessionActive) return;
    
    setIsTranscribing(true);
    
    try {
      // 1. Transcrição
      const result = await api.transcribe(base64, mimeType, estimatedDuration);
      setIsTranscribing(false);
      
      if (!result.text || result.text.trim().length < 5) return;
      
      const question = result.text.trim();
      setCurrentTranscription(question);
      
      // 2. Adiciona à fila de processamento (Q&A)
      queueQuestion(question);
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
    silenceThreshold: 800, // VAD de 800ms
    maxChunkMs: 12000,
    minChunkMs: 3000
  });

  // Timer (Mantido)
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
  }, [qaList, currentTranscription, isGenerating, stealthMode, currentAnswer]);

  // Atalhos de teclado (Mantido)
  useKeyboardShortcuts({
    onTogglePause: () => audioStatus === 'recording' ? pause() : resume(),
    onStop: stopSession,
    onToggleStealth: () => setStealthMode(s => !s),
    isActive: sessionActive,
    captureStatus: audioStatus
  });

  // Controles de sessão (Mantido)
  const startSession = async (source) => {
    // ... (Lógica de startSession mantida)
  };

  const stopSession = async () => {
    // ... (Lógica de stopSession mantida)
  };

  const exportSession = async () => {
    // ... (Lógica de exportSession mantida)
  };

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

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
        {/* ... (Header Mantido) ... */}
      </header>

      <main className="app-main" ref={scrollRef}>
        {!sessionActive ? (
          <div className="start-screen">
            {/* ... (Start Screen Mantido) ... */}
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
              {qaList.length === 0 && !currentTranscription && !isTranscribing && !currentAnswer && (
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
              
              {/* Novo Card para Streaming */}
              {currentAnswer && (
                <QACard
                  key={currentAnswer.id}
                  qa={currentAnswer}
                  isExpanded={true}
                  isStreaming={true}
                  onToggle={() => {}}
                  isStarred={false}
                  onStar={() => {}}
                />
              )}

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
              {/* ... (Control Bar Mantido) ... */}
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

      {/* ... (Modals e Erros Mantidos) ... */}
    </div>
  );
}
