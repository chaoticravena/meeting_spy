// src/useParallelQueue.js - Fila paralela com debounce
import { useRef, useCallback } from 'react';

export function useParallelQueue(processFn, options = {}) {
  const { maxConcurrent = 2, debounceMs = 250 } = options;
  
  const queue = useRef([]);
  const processing = useRef(new Set());
  const debounceTimers = useRef(new Map());
  const lastProcessed = useRef(new Map());
  const stats = useRef({ processed: 0, deduped: 0, errors: 0 });

  // Normaliza para comparação
  const normalize = (str) => str.toLowerCase().replace(/[^\w\s]/g, ' ').trim().replace(/\s+/g, ' ');

  const processQueue = useCallback(async () => {
    if (processing.current.size >= maxConcurrent || queue.current.length === 0) return;
    
    const item = queue.current.shift();
    const id = Date.now() + Math.random().toString(36).substr(2, 9);
    processing.current.add(id);
    
    try {
      await processFn(item.data, item.metadata);
      stats.current.processed++;
    } catch (err) {
      stats.current.errors++;
      console.error('Queue processing error:', err);
    } finally {
      processing.current.delete(id);
      // Agenda próximo
      if (queue.current.length > 0) {
        setTimeout(processQueue, 10);
      }
    }
  }, [processFn, maxConcurrent]);

  const add = useCallback((data, metadata = {}) => {
    const question = data.question || data;
    const normalized = normalize(question);
    
    // Debounce: cancela timer anterior se existir
    if (debounceTimers.current.has(normalized)) {
      clearTimeout(debounceTimers.current.get(normalized));
    }
    
    const timer = setTimeout(() => {
      debounceTimers.current.delete(normalized);
      
      // Dedup: ignora se processou algo muito similar nos últimos 5s
      const now = Date.now();
      for (const [key, timestamp] of lastProcessed.current) {
        if (now - timestamp < 5000) {
          // Compara similaridade
          const common = key.split(' ').filter(w => normalized.includes(w)).length;
          const total = new Set([...key.split(' '), ...normalized.split(' ')]).size;
          if (common / total > 0.8) {
            stats.current.deduped++;
            return;
          }
        }
      }
      
      lastProcessed.current.set(normalized, now);
      // Limpa antigos
      if (lastProcessed.current.size > 20) {
        const oldest = lastProcessed.current.keys().next().value;
        lastProcessed.current.delete(oldest);
      }
      
      // Adiciona à fila
      queue.current.push({ data, metadata });
      
      // Inicia processamento se possível
      processQueue();
      
    }, debounceMs);
    
    debounceTimers.current.set(normalized, timer);
  }, [processQueue, debounceMs]);

  const clear = useCallback(() => {
    queue.current = [];
    processing.current.clear();
    debounceTimers.current.forEach(t => clearTimeout(t));
    debounceTimers.current.clear();
    lastProcessed.current.clear();
  }, []);

  const getStats = useCallback(() => ({
    queueLength: queue.current.length,
    processing: processing.current.size,
    ...stats.current
  }), []);

  return { add, clear, getStats, isProcessing: () => processing.current.size > 0 };
}
