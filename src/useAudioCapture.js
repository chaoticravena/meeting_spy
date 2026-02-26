// src/useAudioCapture.js
import { useState, useRef, useCallback } from 'react';

const useAudioCapture = ({ onSpeechEnd, silenceThreshold = 2000, minSpeechDuration = 1000 }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  
  // Timers
  const silenceTimerRef = useRef(null);
  const speechStartTimeRef = useRef(null);
  const isRecordingSpeechRef = useRef(false);

  // Análise de áudio em tempo real
  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current || !isRecording) return;
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    // Calcula volume RMS
    const sum = dataArray.reduce((acc, val) => acc + val * val, 0);
    const rms = Math.sqrt(sum / dataArray.length);
    setAudioLevel(rms);
    
    const SPEECH_THRESHOLD = 20;
    const isSpeechNow = rms > SPEECH_THRESHOLD;
    
    if (isSpeechNow && !isRecordingSpeechRef.current) {
      // INÍCIO DA FALA
      isRecordingSpeechRef.current = true;
      speechStartTimeRef.current = Date.now();
      setIsSpeaking(true);
      
      // Limpa timer de silêncio se existir
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      
    } else if (!isSpeechNow && isRecordingSpeechRef.current) {
      // POSSÍVEL FIM DA FALA - inicia timer de confirmação
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          const speechDuration = Date.now() - speechStartTimeRef.current;
          
          // Só processa se fala foi significativa (>1s)
          if (speechDuration > minSpeechDuration) {
            finalizeSpeechSegment();
          }
          
          isRecordingSpeechRef.current = false;
          setIsSpeaking(false);
          silenceTimerRef.current = null;
        }, silenceThreshold);
      }
    }
    
    if (isRecording) {
      requestAnimationFrame(analyzeAudio);
    }
  }, [isRecording, silenceThreshold, minSpeechDuration]);

  const finalizeSpeechSegment = useCallback(async () => {
    if (chunksRef.current.length === 0) return;
    
    // Para gravação temporariamente
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    
    // Aguarda o último chunk
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Cria blob completo da fala
    const audioBlob = new Blob(chunksRef.current, { 
      type: 'audio/webm;codecs=opus' 
    });
    
    // Limpa buffer para próxima fala
    const duration = Date.now() - speechStartTimeRef.current;
    chunksRef.current = [];
    
    // Envia fala COMPLETA para processamento
    try {
      await onSpeechEnd(audioBlob, duration);
    } catch (err) {
      console.error('Erro ao processar fala:', err);
    }
    
    // Reinicia gravação para próxima fala
    if (isRecording && mediaRecorderRef.current?.state === 'inactive') {
      startMediaRecorder();
    }
  }, [isRecording, onSpeechEnd]);

  const startMediaRecorder = useCallback(() => {
    if (!streamRef.current) return;
    
    mediaRecorderRef.current = new MediaRecorder(streamRef.current, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 24000 // Qualidade boa, arquivo pequeno
    });
    
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    
    // Grava em timeslices pequenos para não perder dados entre pausas
    mediaRecorderRef.current.start(200);
  }, []);

  const startRecording = useCallback(async (source = 'microphone') => {
    try {
      let stream;
      
      if (source === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 24000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: false
        });
      }
      
      streamRef.current = stream;
      
      // Setup AudioContext para análise
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 512;
      analyserRef.current.smoothingTimeConstant = 0.8; // Suaviza leituras
      
      const sourceNode = audioContextRef.current.createMediaStreamSource(stream);
      sourceNode.connect(analyserRef.current);
      
      // Inicia gravação contínua
      startMediaRecorder();
      setIsRecording(true);
      
      // Inicia loop de análise
      analyzeAudio();
      
    } catch (err) {
      console.error('Erro ao iniciar:', err);
      throw err;
    }
  }, [analyzeAudio, startMediaRecorder]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setIsSpeaking(false);
    
    // Limpa timers
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    
    // Processa fala atual se houver
    if (isRecordingSpeechRef.current && chunksRef.current.length > 0) {
      finalizeSpeechSegment();
    }
    
    // Limpa recursos
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();
    
    chunksRef.current = [];
    isRecordingSpeechRef.current = false;
  }, [finalizeSpeechSegment]);

  return {
    isRecording,
    isSpeaking,
    audioLevel,
    startRecording,
    stopRecording
  };
};

export default useAudioCapture;
