// src/components/StealthWidget.jsx - Widget minimalista flutuante
export function StealthWidget({ 
  status, 
  elapsedTime, 
  qaCount, 
  currentTranscription,
  onTogglePause,
  onStop,
  onExpand 
}) {
  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const statusColors = {
    recording: 'bg-red-500 animate-pulse',
    paused: 'bg-yellow-500',
    processing: 'bg-blue-500 animate-pulse'
  };

  return (
    <div className="stealth-widget">
      <div className={`status-dot ${statusColors[status] || 'bg-gray-500'}`} />
      
      <div className="widget-info">
        <span className="timer">{formatTime(elapsedTime)}</span>
        <span className="count">Q: {qaCount}</span>
      </div>
      
      {currentTranscription && (
        <div className="mini-transcription" title={currentTranscription}>
          {currentTranscription.slice(0, 40)}...
        </div>
      )}
      
      <div className="widget-controls">
        <button onClick={onTogglePause} className="mini-btn">
          {status === 'recording' ? '⏸' : '▶'}
        </button>
        <button onClick={onExpand} className="mini-btn" title="Expandir (Ctrl+H)">
          ⛶
        </button>
        <button onClick={onStop} className="mini-btn stop" title="Encerrar (Esc)">
          ⏹
        </button>
      </div>
    </div>
  );
}
