// src/useAudioCapture.js
import { useState, useRef, useCallback } from 'react';

const useAudioCapture = ({ onAudioChunk, chunkDuration = 3000, silenceThreshold = 1500 }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioSource, setAudioSource] = useState('microphone');
  const [error, setError] = useState(null);
  
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const silenceTimerRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const isSpeechActiveRef = useRef(false);

  // Análise de frequência para detectar fala
  const analyzeAudioLevel = useCallback(() => {
    if (!analyserRef.current || !isRecording) return;
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    // Calcula volume médio
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    const isSpeech = average > 15; // Threshold ajustável
    
    if (isSpeech && !isSpeechActiveRef.current) {
      // Início da fala detectado
      isSpeechActiveRef.current = true;
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    } else if (!isSpeech && isSpeechActiveRef.current) {
      // Possível fim da fala
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          isSpeechActiveRef.current = false;
          // Força processamento do chunk atual
          if (mediaRecorderRef.current?.state === 'recording') {
            finalizeCurrentChunk();
          }
        }, silenceThreshold);
      }
    }
    
    if (isRecording) {
      requestAnimationFrame(analyzeAudioLevel);
    }
  }, [isRecording, silenceThreshold]);

  const finalizeCurrentChunk = useCallback(async () => {
    if (chunksRef.current.length === 0) return;
    
    // Para gravação temporariamente
    mediaRecorderRef.current.stop();
    
    // Cria blob do áudio acumulado
    const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' });
    chunksRef.current = [];
    
    // Envia para processamento
    try {
      await onAudioChunk(audioBlob);
    } catch (err) {
      console.error('Erro ao processar chunk:', err);
    }
    
    // Reinicia gravação se ainda estiver gravando
    if (isRecording && mediaRecorderRef.current?.state === 'inactive') {
      startNewChunk();
    }
  }, [isRecording, onAudioChunk]);

  const startNewChunk = useCallback(() => {
    if (!streamRef.current) return;
    
    mediaRecorderRef.current = new MediaRecorder(streamRef.current, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 16000 // Qualidade suficiente para whisper, arquivo menor
    });
    
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    
    mediaRecorderRef.current.onstop = () => {
      // Auto-reinicia após 100ms para não perder áudio
      if (isRecording) {
        setTimeout(() => startNewChunk(), 100);
      }
    };
    
    // Grava em timeslices de 500ms para não perder dados
    mediaRecorderRef.current.start(500);
    
    // Timeout de segurança: força chunk a cada chunkDuration
    recordingTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') {
        finalizeCurrentChunk();
      }
    }, chunkDuration);
  }, [chunkDuration, finalizeCurrentChunk, isRecording]);

  const startRecording = useCallback(async (source = 'microphone') => {
    try {
      setError(null);
      setAudioSource(source);
      
      let stream;
      if (source === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { 
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
          } 
        });
      } else {
        // System audio via getDisplayMedia
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: false
        });
      }
      
      streamRef.current = stream;
      
      // Setup AudioContext para análise em tempo real
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      
      const sourceNode = audioContextRef.current.createMediaStreamSource(stream);
      sourceNode.connect(analyserRef.current);
      
      // Inicia análise de áudio
      analyzeAudioLevel();
      
      // Inicia gravação
      setIsRecording(true);
      startNewChunk();
      
    } catch (err) {
      setError(err.message);
      console.error('Erro ao iniciar gravação:', err);
    }
  }, [analyzeAudioLevel, startNewChunk]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    
    // Limpa timers
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
    
    // Finaliza chunk atual
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    
    // Limpa recursos
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    
    // Envia último chunk se houver
    if (chunksRef.current.length > 0) {
      const finalBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
      onAudioChunk(finalBlob, true); // true = isFinal
    }
    
    chunksRef.current = [];
    streamRef.current = null;
    mediaRecorderRef.current = null;
  }, [onAudioChunk]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.pause();
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
    }
  }, []);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'paused') {
      mediaRecorderRef.current.resume();
      // Reinicia timer de segurança
      recordingTimerRef.current = setTimeout(() => {
        finalizeCurrentChunk();
      }, chunkDuration);
    }
  }, [chunkDuration, finalizeCurrentChunk]);

  return {
    isRecording,
    audioSource,
    error,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording
  };
};

export default useAudioCapture;
