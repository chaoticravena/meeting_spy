// src/useSmartCache.js - Cache inteligente com similaridade
import { useCallback, useRef } from 'react';

// Hash simples para comparação rápida
function quickHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

// Similaridade de Jaccard (rápida e efetiva para textos curtos)
function jaccardSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const set2 = new Set(str2.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return union.size === 0 ? 0 : intersection.size / union.size;
}

const CACHE_PREFIX = 'ia_cache_v3:';
const MEMORY_LIMIT = 25;
const STORAGE_LIMIT = 150;
const SIMILARITY_THRESHOLD = 0.75;

export function useSmartCache() {
  const memoryCache = useRef(new Map());
  const accessOrder = useRef([]);

  const getCached = useCallback((question) => {
    const normalizedQ = question.toLowerCase().trim();
    const qHash = quickHash(normalizedQ);
    
    // 1. Verifica memória primeiro (O(1))
    const memHit = memoryCache.current.get(qHash);
    if (memHit && jaccardSimilarity(memHit.question, normalizedQ) > 0.9) {
      // Atualiza LRU
      accessOrder.current = accessOrder.current.filter(h => h !== qHash);
      accessOrder.current.push(qHash);
      return { ...memHit.data, cached: true, source: 'memory', latency: 0 };
    }

    // 2. Similaridade aproximada na memória
    for (const [hash, entry] of memoryCache.current) {
      if (jaccardSimilarity(entry.question, normalizedQ) > SIMILARITY_THRESHOLD) {
        accessOrder.current = accessOrder.current.filter(h => h !== hash);
        accessOrder.current.push(hash);
        return { ...entry.data, cached: true, source: 'memory_similar', latency: 5 };
      }
    }

    // 3. Verifica localStorage
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (!key.startsWith(CACHE_PREFIX)) continue;
        
        const cachedQ = key.slice(CACHE_PREFIX.length);
        const similarity = jaccardSimilarity(cachedQ, normalizedQ);
        
        if (similarity > SIMILARITY_THRESHOLD) {
          const data = JSON.parse(localStorage.getItem(key));
          if (Date.now() - data.timestamp < 30 * 24 * 60 * 60 * 1000) {
            // Promove para memória
            promoteToMemory(qHash, normalizedQ, data);
            return { ...data, cached: true, source: 'storage', latency: 10 };
          }
        }
      }
    } catch (e) {
      console.warn('Storage access error:', e);
    }
    
    return null;
  }, []);

  const promoteToMemory = (hash, question, data) => {
    if (memoryCache.current.size >= MEMORY_LIMIT) {
      const lru = accessOrder.current.shift();
      if (lru) memoryCache.current.delete(lru);
    }
    
    memoryCache.current.set(hash, { question, data });
    accessOrder.current.push(hash);
  };

  const setCached = useCallback((question, answer, metadata = {}) => {
    const normalizedQ = question.toLowerCase().trim();
    const qHash = quickHash(normalizedQ);
    
    const data = {
      answer,
      timestamp: Date.now(),
      tokens: metadata.tokens || 0,
      model: metadata.model || 'gpt-4o-mini',
      processingTime: metadata.processingTime || 0
    };
    
    // Salva em memória
    promoteToMemory(qHash, normalizedQ, data);
    
    // Salva em storage (async, não bloqueia)
    setTimeout(() => {
      try {
        const key = CACHE_PREFIX + normalizedQ.slice(0, 120);
        localStorage.setItem(key, JSON.stringify(data));
        
        // Cleanup se necessário
        const allKeys = Object.keys(localStorage)
          .filter(k => k.startsWith(CACHE_PREFIX));
        
        if (allKeys.length > STORAGE_LIMIT) {
          // Remove os mais antigos
          const toRemove = allKeys
            .map(k => ({ key: k, ts: JSON.parse(localStorage.getItem(k)).timestamp }))
            .sort((a, b) => a.ts - b.ts)
            .slice(0, allKeys.length - STORAGE_LIMIT);
          
          toRemove.forEach(({ key }) => localStorage.removeItem(key));
        }
      } catch (e) {
        // Storage full ou privado
      }
    }, 0);
  }, []);

  const getStats = useCallback(() => {
    const storageKeys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
    let totalTokens = 0;
    let totalSaved = 0;
    
    storageKeys.forEach(key => {
      try {
        const data = JSON.parse(localStorage.getItem(key));
        totalTokens += data.tokens || 0;
        // Custo estimado: $0.60 por 1M tokens output
        totalSaved += (data.tokens || 0) / 1000000 * 0.60;
      } catch (e) {}
    });
    
    return {
      memoryItems: memoryCache.current.size,
      storageItems: storageKeys.length,
      totalTokensSaved: totalTokens,
      estimatedCostSaved: totalSaved,
      hitRate: 'N/A' // Calcular em runtime
    };
  }, []);

  const clear = useCallback(() => {
    memoryCache.current.clear();
    accessOrder.current = [];
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  }, []);

  return { getCached, setCached, getStats, clear };
}
