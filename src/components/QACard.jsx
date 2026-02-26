import { useState } from "react";

export function QACard({ qa, isExpanded, onToggle, isStarred, onStar, isStreaming = false }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`qa-card ${isExpanded ? "expanded" : ""} ${isStreaming ? "streaming" : ""}`}>
      <div className="qa-header" onClick={isStreaming ? null : onToggle}>
        <span className="qa-num">{isStreaming ? 'LIVE' : `Q${qa.id}`}</span>
        <span className="qa-q">{qa.question.slice(0, 80)}...</span>
        <div className="qa-badges">
          {isStreaming && <span className="badge streaming">STREAMING</span>}
          {qa.cached && <span className="badge cache">CACHE</span>}
          {qa.tailored && <span className="badge tailored">TAILORED</span>}
          {qa.processingTimeMs > 0 && (
            <span className="badge time">{qa.processingTimeMs}ms</span>
          )}
        </div>
        {!isStreaming && (
          <button onClick={(e) => { e.stopPropagation(); onStar(); }}>
            {isStarred ? "★" : "☆"}
          </button>
        )}
        {!isStreaming && <span className="qa-toggle">{isExpanded ? "▼" : "▶"}</span>}
      </div>
      {(isExpanded || isStreaming) && (
        <div className="qa-body">
          <div className="qa-section">
            <strong>Q:</strong> {qa.question}
          </div>
          <div className="qa-section answer">
            <div className="answer-header">
              <strong>A:</strong>
              <button onClick={() => copyToClipboard(qa.answer)} className="copy-btn">
                {copied ? "✓ Copied!" : "Copy"}
              </button>
            </div>
            <div className="markdown-body">
              {qa.answer.split("\n").map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {isStreaming && <span className="inline-block w-2 h-4 bg-purple-400 ml-1 animate-pulse" />}
            </div>
          </div>
          {qa.cost > 0 && <span className="cost-tag">Cost: ${qa.cost.toFixed(5)}</span>}
        </div>
      )}
    </div>
  );
}
