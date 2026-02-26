// src/App.jsx
import { useState, useCallback, useRef, useEffect } from 'react';
import useAudioCapture from './useAudioCapture';
import api from './api';

function App() {
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const [interactions, setInteractions] = useState([]);
  const [currentStream, setCurrentStream] = useState(null);
  const [status, setStatus] = useState('idle');
  
  // Contexto da conversação (histórico para GPT)
  const conversationContextRef = useRef([]);
  
  // Ref para scroll automático
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [interactions, currentStream]);

  const handleSpeechEnd = useCallback(async (audioBlob, duration) => {
    console.log(`Fala detectada: ${(duration/1000).toFixed(1)}s`);
    setStatus('transcribing');
    
    try {
      // 1. Transcreve áudio completo
      const { transcription, processingTime } = await api.uploadAudio(
        audioBlob, 
        sessionId 
      );
      
      if (!transcription || transcription.trim().length < 3) {
        setStatus('listening');
        return;
      }

      setStatus('generating');
      const startTime = Date.now();

      // 2. Prepara contexto da conversação
      const recentContext = conversationContextRef.current.slice(-4); // Últimas 4 interações
      
      // 3. Inicia streaming da resposta com contexto
      const streamIterator = api.streamAnswerWithContext(
        transcription,
        recentContext,
        sessionId
      );

      // 4. Processa stream
      let fullAnswer = '';
      let isFirstChunk = true;
      
      setCurrentStream({
        transcription,
        answer: '',
        isStreaming: true,
        timestamps: {
          transcribe: processingTime,
          startGenerate: startTime
        }
      });

      for await (const chunk of streamIterator) {
        if (chunk.type === 'content') {
          fullAnswer += chunk.content;
          
          setCurrentStream(prev => ({
            ...prev,
            answer: fullAnswer,
            timestamps: {
              ...prev.timestamps,
              firstToken: isFirstChunk ? Date.now() : prev.timestamps.firstToken
            }
          }));
          
          isFirstChunk = false;
          
        } else if (chunk.type === 'done') {
          // Finaliza e salva no histórico
          const finalInteraction = {
            id: Date.now(),
            transcription,
            answer: fullAnswer,
            timestamps: {
              transcribe: processingTime,
              generate: Date.now() - startTime,
              total: processingTime + (Date.now() - startTime),
              tokens: chunk.usage?.completion_tokens
            }
          };
          
          // Atualiza contexto para próxima interação
          conversationContextRef.current.push({
            role: 'user',
            content: transcription
          });
          conversationContextRef.current.push({
            role: 'assistant',
            content: fullAnswer
          });
          
          setInteractions(prev => [...prev, finalInteraction]);
          setCurrentStream(null);
          setStatus('listening');
        }
      }
      
    } catch (error) {
      console.error('Erro:', error);
      setStatus('error');
      setCurrentStream(null);
    }
  }, [sessionId]);

  const { isRecording, isSpeaking, audioLevel, startRecording, stopRecording } = useAudioCapture({
    onSpeechEnd: handleSpeechEnd,
    silenceThreshold: 2000,  // 2s de silêncio = fim de fala
    minSpeechDuration: 800    // Mínimo 0.8s para evitar ruídos
  });

  const getStats = () => {
    if (interactions.length === 0) return null;
    const avgLatency = interactions.reduce((s, i) => s + i.timestamps.total, 0) / interactions.length;
    return {
      count: interactions.length,
      avgLatency: (avgLatency / 1000).toFixed(1),
      totalTokens: interactions.reduce((s, i) => s + (i.timestamps.tokens || 0), 0)
    };
  };

  const stats = getStats();

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Interview Agent Pro
            </h1>
            {stats && (
              <p className="text-sm text-gray-400 mt-1">
                {stats.count} perguntas • {stats.avgLatency}s média • {stats.totalTokens} tokens
              </p>
            )}
          </div>
          
          <div className="flex gap-3">
            {!isRecording ? (
              <>
                <button
                  onClick={() => startRecording('microphone')}
                  className="px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-2"
                >
                  <span>🎤</span> Microfone
                </button>
                <button
                  onClick={() => startRecording('system')}
                  className="px-4 py-2 bg-purple-600 rounded-lg hover:bg-purple-700 flex items-center gap-2"
                >
                  <span>🖥️</span> Sistema
                </button>
              </>
            ) : (
              <button
                onClick={stopRecording}
                className="px-4 py-2 bg-red-600 rounded-lg hover:bg-red-700 flex items-center gap-2"
              >
                <span>⏹️</span> Parar
              </button>
            )}
          </div>
        </div>

        {/* Visualizador de Áudio */}
        {isRecording && (
          <div className="mb-6 bg-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-4">
              <div className={`w-3 h-3 rounded-full ${isSpeaking ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
              <span className="text-sm text-gray-300">
                {isSpeaking ? 'Detectando fala...' : 'Aguardando fala...'}
              </span>
              <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-100"
                  style={{ width: `${Math.min(audioLevel * 2, 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Status */}
        {status !== 'idle' && (
          <div className="mb-4 flex items-center gap-2 text-sm">
            <div className={`w-2 h-2 rounded-full animate-pulse ${
              status === 'transcribing' ? 'bg-yellow-500' : 
              status === 'generating' ? 'bg-blue-500' : 'bg-gray-500'
            }`} />
            <span className="text-gray-400">
              {status === 'transcribing' && 'Transcrevendo fala...'}
              {status === 'generating' && 'Gerando resposta...'}
              {status === 'listening' && 'Pronto para próxima pergunta'}
              {status === 'error' && 'Erro no processamento'}
            </span>
          </div>
        )}

        {/* Lista de Interações */}
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {interactions.map((item, index) => (
            <div 
              key={item.id} 
              className="bg-gray-800 rounded-lg p-5 border border-gray-700"
            >
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-semibold text-blue-400">
                  PERGUNTA #{index + 1}
                </span>
                <div className="text-xs text-gray-500 space-x-3">
                  <span>🎤 {(item.timestamps.transcribe/1000).toFixed(1)}s</span>
                  <span>🤖 {(item.timestamps.generate/1000).toFixed(1)}s</span>
                  <span className="text-green-400">{(item.timestamps.total/1000).toFixed(1)}s total</span>
                </div>
              </div>
              
              <div className="mb-4 pb-4 border-b border-gray-700">
                <p className="text-gray-300 italic">"{item.transcription}"</p>
              </div>
              
              <div className="prose prose-invert max-w-none">
                <div className="text-gray-100 whitespace-pre-wrap">
                  {item.answer}
                </div>
              </div>
            </div>
          ))}

          {/* Streaming Atual */}
          {currentStream && (
            <div className="bg-gray-800 rounded-lg p-5 border-2 border-blue-500/50 animate-pulse">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs font-semibold text-blue-400 animate-pulse">
                  PROCESSANDO...
                </span>
                {currentStream.timestamps.firstToken && (
                  <span className="text-xs text-green-400">
                    TTFT: {((currentStream.timestamps.firstToken - currentStream.timestamps.startGenerate)/1000).toFixed(2)}s
                  </span>
                )}
              </div>
              
              <div className="mb-4 pb-4 border-b border-gray-700/50">
                <p className="text-gray-400 italic">"{currentStream.transcription}"</p>
              </div>
              
              <div className="text-gray-100 whitespace-pre-wrap">
                {currentStream.answer}
                <span className="inline-block w-2 h-4 bg-purple-400 ml-1 animate-pulse" />
              </div>
            </div>
          )}
          
          <div ref={scrollRef} />
        </div>
      </div>
    </div>
  );
}

export default App;
