// src/useLocalCache.js - Hook para cache de respostas
const CACHE_PREFIX = 'interview_cache:';
const MAX_CACHE_ITEMS = 50;

export function useLocalCache() {
  const getCached = (question) => {
    try {
      const key = (CACHE_PREFIX + question.toLowerCase().trim()).slice(0, 100);
      const cached = localStorage.getItem(key);
      if (!cached) return null;
      
      const { answer, timestamp } = JSON.parse(cached);
      // Cache válido por 30 dias
      if (Date.now() - timestamp > 30 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(key);
        return null;
      }
      return { answer, processingTimeMs: 0, cached: true };
    } catch {
      return null;
    }
  };

  const setCached = (question, answer) => {
    try {
      const key = (CACHE_PREFIX + question.toLowerCase().trim()).slice(0, 100);
      const data = { answer, timestamp: Date.now() };
      localStorage.setItem(key, JSON.stringify(data));
      
      // Limpeza: mantém apenas os 50 mais recentes
      const keys = Object.keys(localStorage)
        .filter(k => k.startsWith(CACHE_PREFIX))
        .sort((a, b) => {
          const ta = JSON.parse(localStorage.getItem(a)).timestamp;
          const tb = JSON.parse(localStorage.getItem(b)).timestamp;
          return ta - tb;
        });
      
      if (keys.length > MAX_CACHE_ITEMS) {
        keys.slice(0, keys.length - MAX_CACHE_ITEMS).forEach(k => localStorage.removeItem(k));
      }
    } catch (e) {
      console.warn('Cache falhou:', e);
    }
  };

  const clearCache = () => {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  };

  return { getCached, setCached, clearCache };
}
