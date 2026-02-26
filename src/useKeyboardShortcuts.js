// src/useKeyboardShortcuts.js - Novo hook para atalhos
import { useEffect } from 'react';

export function useKeyboardShortcuts({
  onTogglePause,
  onStop,
  onToggleStealth,
  isActive,
  captureStatus
}) {
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e) => {
      // Ctrl + Space: Pausar/Retomar
      if (e.code === 'Space' && e.ctrlKey) {
        e.preventDefault();
        onTogglePause();
      }
      
      // Ctrl + H: Modo discreto
      if (e.code === 'KeyH' && e.ctrlKey) {
        e.preventDefault();
        onToggleStealth();
      }
      
      // Escape: Encerrar sessão (com confirmação)
      if (e.code === 'Escape') {
        const confirmStop = window.confirm('Encerrar sessão?');
        if (confirmStop) onStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, captureStatus, onTogglePause, onStop, onToggleStealth]);
}
