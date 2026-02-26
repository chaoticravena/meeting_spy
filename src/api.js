// src/api.js - Cliente API completo
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

export const api = {
  // Health & Stats
  health: () => request("/health", {}, 5000),
  getStats: () => request("/stats", {}, 5000),
  
  // Job Profiles
  listJobs: () => request("/jobs"),
  getDefaultJob: () => request("/jobs/default"),
  createJob: (data) => request("/jobs", { method: "POST", body: JSON.stringify(data) }, 10000),
  deleteJob: (id) => request(`/jobs/${id}`, { method: "DELETE" }),
  
  // Sessions
  createSession: (jobProfileId) => request("/session/create", {
    method: "POST",
    body: JSON.stringify({ jobProfileId })
  }, 5000),
  endSession: (sessionId, totalQuestions) => request("/session/end", {
    method: "POST",
    body: JSON.stringify({ sessionId, totalQuestions })
  }, 5000),
  
  // Voice & AI
  transcribe: (audioBase64, mimeType = "audio/webm", language = "en", estimatedDuration = 0) =>
    request("/voice/transcribe", {
      method: "POST",
      body: JSON.stringify({ audioBase64, mimeType, language, estimatedDuration })
    }, 15000),
  
  answer: (question, sessionId, previousQAs = []) =>
    request("/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question, sessionId, previousQAs })
    }, 45000),
  
  // Export
  exportSession: (id) => request(`/session/${id}/export`, {}, 10000),
};
