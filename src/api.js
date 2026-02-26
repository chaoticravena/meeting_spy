// src/api.js
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

class InterviewAPI {
  async uploadAudio(audioBlob, sessionId) {
    const formData = new FormData();
    formData.append('audio', audioBlob, `speech-${Date.now()}.webm`);
    formData.append('sessionId', sessionId);

    const response = await fetch(`${API_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) throw new Error('Transcription failed');
    return response.json();
  }

  // Streaming com contexto de conversação
  async *streamAnswerWithContext(transcription, context, sessionId) {
    const response = await fetch(`${API_URL}/api/answer-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcription,
        context, // Array de {role, content} das interações anteriores
        sessionId
      }),
    });

    if (!response.ok) throw new Error('Stream failed');

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
            yield JSON.parse(data);
          } catch (e) {
            // ignora
          }
        }
      }
    }
  }
}

export default new InterviewAPI();
