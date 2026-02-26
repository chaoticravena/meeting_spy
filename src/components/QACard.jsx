// src/components/QACard.jsx - Atualizado com Follow-up e Cost
import { useState } from 'react';

export function QACard({ qa, isExpanded, onToggle, isStarred, onStar }) {
  const [copied, setCopied] = useState(false);
  const [showCost, setShowCost] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(qa.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  // Separa a resposta técnica da estimativa de custo
  const technicalAnswer = qa.answer.split('### 💰 Estimated Cloud Cost')[0].trim();
  const hasCostEstimate = qa.answer.includes('### 💰 Estimated Cloud Cost');
  
  // Extrai follow-up se não estiver no objeto separado
  const followUp = qa.followUpQuestion || 
    (qa.answer.match(/💡 \*\*Follow-up:\*\* (.+?)(?:\n|$)/)?.[1]);

  return (
    <div className={`qa-card ${qa.cached ? 'cached' : ''} ${qa.tailored ? 'tailored' : ''} ${isStarred ? 'starred' : ''}`}>
      <div className="qa-header" onClick={onToggle}>
        <span className="qa-number">#{qa.id}</span>
        <span className="qa-preview">{qa.question}</span>
        <div className="qa-badges">
          {qa.cached && <span className="badge cache" title="From cache">⚡</span>}
          {qa.tailored && <span className="badge tailored" title="Tailored to job">🎯</span>}
          {hasCostEstimate && <span className="badge cost" title="Cost estimate">💰</span>}
          {followUp && <span className="badge followup" title="Has follow-up">💡</span>}
          <button 
            className={`star-btn ${isStarred ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onStar(); }}
          >
            {isStarred ? '★' : '☆'}
          </button>
          <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
        </div>
      </div>
      
      {isExpanded && (
        <div className="qa-body">
          <div className="qa-question-section">
            <strong>Question:</strong>
            <p>{qa.question}</p>
          </div>
          
          <div className="qa-answer-section">
            <div className="answer-header">
              <strong>Answer:</strong>
              <button 
                className={`copy-btn ${copied ? 'copied' : ''}`}
                onClick={copy}
              >
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            <div className="answer-content markdown-body">
              {technicalAnswer.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            
            {/* Follow-up Question */}
            {followUp && (
              <div className="follow-up-section">
                <div className="follow-up-header">
                  <span className="icon">💡</span>
                  <strong>Suggested Follow-up Question</strong>
                </div>
                <p className="follow-up-text">{followUp}</p>
                <button 
                  className="btn-use-followup"
                  onClick={() => {
                    // Simula digitar na interface (se implementado)
                    navigator.clipboard.writeText(followUp);
                  }}
                >
                  Copy to Ask
                </button>
              </div>
            )}
            
            {/* Cloud Cost Estimate */}
            {hasCostEstimate && (
              <div className="cost-section">
                <div 
                  className="cost-header"
                  onClick={() => setShowCost(!showCost)}
                >
                  <span className="icon">💰</span>
                  <strong>Cloud Cost Estimate</strong>
                  <span className="toggle">{showCost ? '▼' : '▶'}</span>
                </div>
                {showCost && (
                  <div className="cost-content markdown-body">
                    {qa.answer.split('### 💰 Estimated Cloud Cost')[1].split('\n\n>')[0].split('\n').map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
            
            <div className="answer-meta">
              {qa.processingTimeMs > 0 && <span>⏱ {qa.processingTimeMs}ms</span>}
              {qa.cost && <span>💵 ${qa.cost}</span>}
              {qa.tokens && <span>📝 {qa.tokens.input}→{qa.tokens.output}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
