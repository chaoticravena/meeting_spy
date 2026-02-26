const BASE_URL = 
  process.env.NODE_ENV === "production" ? "" : "http://localhost:3001";

async function request(endpoint, options = {} ) {
  const { body, ...rest } = options;
  const headers = { ...rest.headers };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}

export const api = {
  // Job Profiles
  getJobs: () => request("/api/jobs"),
  createJob: (data) => request("/api/jobs", { method: "POST", body: data }),
  updateJob: (id, data) => request(`/api/jobs/${id}`, { method: "PUT", body: data }),
  deleteJob: (id) => request(`/api/jobs/${id}`, { method: "DELETE" }),
  setDefaultJob: (id) => request(`/api/jobs/${id}/default`, { method: "POST" }),
  getDefaultJob: () => request("/api/jobs/default"),

  // Sessions
  createSession: (jobId) => request("/api/session/create", { method: "POST", body: { jobId } }),
  endSession: (sessionId, totalQuestions) =>
    request("/api/session/end", { method: "POST", body: { sessionId, totalQuestions } }),

  // Core AI - Transcrição
  transcribe: (audioBase64, mimeType, estimatedDuration) =>
    request("/api/voice/transcribe", {
      method: "POST",
      body: { audioBase64, mimeType, estimatedDuration },
    }),
    
  // Core AI - Streaming de Resposta (SSE)
  async *streamAnswer(question, sessionId, previousQAs) {
    const response = await fetch(`${BASE_URL}/api/ai/answer-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        sessionId,
        previousQAs,
        maxTokens: 1024,
        temperature: 0.4
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}. Details: ${errorText.slice(0, 100)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
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
};
