// src/api.js
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

class InterviewAPI {
  constructor() {
    this.baseURL = API_URL;
  }

  // Upload de áudio com progresso
  async uploadAudio(audioBlob, sessionId, isFinal = false) {
    const formData = new FormData();
    formData.append('audio', audioBlob, `chunk-${Date.now()}.webm`);
    formData.append('sessionId', sessionId);
    formData.append('timestamp', Date.now().toString());
    formData.append('isFinal', isFinal.toString());

    const response = await fetch(`${this.baseURL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  // Streaming de resposta (Server-Sent Events)
  async *streamAnswer(transcription, sessionId) {
    const response = await fetch(`${this.baseURL}/api/answer-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        transcription, 
        sessionId,
        maxTokens: 400, // Limita para respostas rápidas
        temperature: 0.3
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch (e) {
            // Ignora linhas inválidas
          }
        }
      }
    }
  }

  // Buscar histórico
  async getHistory(sessionId) {
    const response = await fetch(`${this.baseURL}/api/history/${sessionId}`);
    return response.json();
  }

  // Limpar sessão
  async clearSession(sessionId) {
    await fetch(`${this.baseURL}/api/session/${sessionId}`, {
      method: 'DELETE'
    });
  }
}

export default new InterviewAPI();
