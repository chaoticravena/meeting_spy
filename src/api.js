// src/api.js - Cliente otimizado
const BASE = "/api";

async function request(path, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Request failed");
    }
    
    return res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Request timeout');
    throw err;
  }
}

// Streaming API para respostas mais rápidas
async function* streamRequest(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { "Content-Type": "application/json" },
    body: options.body,
  });
  
  if (!res.ok) throw new Error('Stream failed');
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          yield data;
        } catch (e) {}
      }
    }
  }
}

export const api = {
  // Sessions
  createSession: () => request("/session/create", { method: "POST" }, 5000),
  endSession: (sessionId, totalQuestions) =>
    request("/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId, totalQuestions }),
    }, 5000),
  
  // Voice - otimizado
  transcribe: (audioBase64, mimeType = "audio/webm", language = "en", estimatedDuration = 0) =>
    request("/voice/transcribe", {
      method: "POST",
      body: JSON.stringify({ audioBase64, mimeType, language, estimatedDuration }),
    }, 15000), // Whisper geralmente é rápido

  // AI - com streaming opcional
  answer: (question, sessionId, previousQAs = [], stream = false) =>
    request("/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question, sessionId, previousQAs, stream }),
    }, 45000), // GPT pode demorar para respostas longas
  
  // Streaming para UX mais rápida
  answerStream: async function* (question, sessionId, previousQAs = []) {
    yield* streamRequest("/ai/answer", {
      body: JSON.stringify({ question, sessionId, previousQAs, stream: true }),
    });
  },

  // Stats
  getStats: () => request("/stats", {}, 5000),
  
  // Export
  exportSession: (id) => request(`/session/${id}/export`, {}, 10000),
};
