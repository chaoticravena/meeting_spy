// src/components/QACard.jsx - Componente extrato do card
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

export function QACard({ qa, isExpanded, onToggle, onStar, isStarred }) {
  const [copied, setCopied] = useState(false);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(qa.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Falha ao copiar:', err);
    }
  };

  return (
    <div className={`qa-card ${isStarred ? 'starred' : ''}`}>
      <div className="qa-header" onClick={onToggle}>
        <span className="qa-number">#{qa.id}</span>
        <span className="qa-preview">{qa.question.slice(0, 60)}...</span>
        <div className="qa-actions">
          <button 
            onClick={(e) => { e.stopPropagation(); onStar(); }}
            className={`star-btn ${isStarred ? 'active' : ''}`}
            title="Favoritar"
          >
            {isStarred ? '★' : '☆'}
          </button>
          <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
        </div>
      </div>
      
      {isExpanded && (
        <div className="qa-content">
          <div className="question-section">
            <strong>Pergunta:</strong>
            <p>{qa.question}</p>
          </div>
          
          <div className="answer-section">
            <div className="answer-header">
              <strong>Resposta:</strong>
              <button 
                onClick={copyAnswer}
                className={`copy-btn ${copied ? 'copied' : ''}`}
              >
                {copied ? '✓ Copiado!' : 'Copiar'}
              </button>
            </div>
            <div className="markdown-content">
              <ReactMarkdown>{qa.answer}</ReactMarkdown>
            </div>
            {qa.cached && <span className="cache-badge">📦 Cache</span>}
          </div>
          
          <div className="qa-meta">
            {qa.processingTimeMs > 0 && (
              <span>{qa.processingTimeMs}ms</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
