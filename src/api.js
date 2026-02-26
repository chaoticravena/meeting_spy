// src/api.js
const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export const api = {
  // Sessions
  createSession: () => request("/session/create", { method: "POST" }),
  endSession: (sessionId, totalQuestions) =>
    request("/session/end", {
      method: "POST",
      body: JSON.stringify({ sessionId, totalQuestions }),
    }),
  getSession: (id) => request(`/session/${id}`),
  listSessions: () => request("/sessions"),
  getSessionQAs: (id) => request(`/session/${id}/qas`),
  exportSession: (id) => request(`/session/${id}/export`),

  // Voice
  transcribe: (audioBase64, mimeType = "audio/webm", language = "en") =>
    request("/voice/transcribe", {
      method: "POST",
      body: JSON.stringify({ audioBase64, mimeType, language }),
    }),

  // AI
  answer: (question, sessionId, previousQAs = []) =>
    request("/ai/answer", {
      method: "POST",
      body: JSON.stringify({ question, sessionId, previousQAs }),
    }),
};
