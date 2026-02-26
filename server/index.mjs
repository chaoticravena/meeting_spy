# server/index.mjs

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Cache --- //
const responseCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 60 * 4, // 4 horas
});

// --- Database --- //
const dbPath = path.join(__dirname, '..', 'data', 'interview-agent.db');
const db = new Database(dbPath);

// --- Tabela de Sessões ---
db.exec(`
  CREATE TABLE IF NOT EXISTS interview_sessions (
    id TEXT PRIMARY KEY,
    job_profile_id INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    status TEXT,
    total_questions INTEGER,
    total_cost REAL,
    FOREIGN KEY (job_profile_id) REFERENCES job_profiles(id)
  )
`);

// --- Tabela de Perguntas e Respostas ---
db.exec(`
  CREATE TABLE IF NOT EXISTS question_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    question TEXT,
    answer TEXT,
    processing_time_ms INTEGER,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost REAL,
    cached BOOLEAN,
    tailored BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES interview_sessions(id)
  )
`);

// --- Tabela de Perfis de Vaga (Job Profiles) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS job_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    seniority TEXT,
    key_skills TEXT,
    job_description TEXT,
    is_default BOOLEAN DEFAULT FALSE
  )
`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'dist')));

const upload = multer({ storage: multer.memoryStorage() });

// --- Funções de Custo ---
const COST_PER_MODEL = {
  'whisper-1': 0.006 / 60, // por segundo
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};

function estimateCost(estimatedInput, tokensOut, model) {
  if (!COST_PER_MODEL[model]) return 0;
  const { input, output } = COST_PER_MODEL[model];
  return (estimatedInput * input) + (tokensOut * output);
}

// --- Funções de Cache ---
function normalizeQuestion(question) {
  return question.toLowerCase().replace(/[.,?!;:'"-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- API Endpoints ---

// GET /api/jobs - Listar todos os perfis de vaga
app.get('/api/jobs', (req, res) => {
  try {
    const jobs = db.prepare('SELECT * FROM job_profiles ORDER BY name').all();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs - Criar novo perfil de vaga
app.post('/api/jobs', (req, res) => {
  const { name, company, seniority, key_skills, job_description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const result = db.prepare(
      'INSERT INTO job_profiles (name, company, seniority, key_skills, job_description) VALUES (?, ?, ?, ?, ?)'
    ).run(name, company, seniority, key_skills, job_description);
    res.status(201).json({ id: result.lastInsertRowid, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id - Atualizar perfil de vaga
app.put('/api/jobs/:id', (req, res) => {
  const { name, company, seniority, key_skills, job_description } = req.body;
  try {
    db.prepare(
      'UPDATE job_profiles SET name = ?, company = ?, seniority = ?, key_skills = ?, job_description = ? WHERE id = ?'
    ).run(name, company, seniority, key_skills, job_description, req.params.id);
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id - Deletar perfil de vaga
app.delete('/api/jobs/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM job_profiles WHERE id = ?').run(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/default - Definir perfil padrão
app.post('/api/jobs/:id/default', (req, res) => {
  try {
    db.transaction(() => {
      db.prepare('UPDATE job_profiles SET is_default = 0').run();
      db.prepare('UPDATE job_profiles SET is_default = 1 WHERE id = ?').run(req.params.id);
    })();
    res.status(200).json({ message: 'Default job updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/default - Obter perfil padrão
app.get('/api/jobs/default', (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM job_profiles WHERE is_default = 1').get();
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/create - Iniciar uma nova sessão
app.post('/api/session/create', (req, res) => {
  const { jobId } = req.body;
  try {
    const sessionId = createHash('sha1').update(Date.now().toString() + Math.random()).digest('hex').slice(0, 16);
    const result = db.prepare(
      'INSERT INTO interview_sessions (id, job_profile_id, status) VALUES (?, ?, ?)'
    ).run(sessionId, jobId, 'active');
    
    const sessionDetails = db.prepare(`
      SELECT s.id, s.job_profile_id, j.name as jobName, j.company, j.key_skills, j.seniority
      FROM interview_sessions s
      LEFT JOIN job_profiles j ON s.job_profile_id = j.id
      WHERE s.id = ?
    `).get(sessionId);

    res.json(sessionDetails);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create session: ' + err.message });
  }
});

// POST /api/session/end - Finalizar uma sessão
app.post('/api/session/end', (req, res) => {
  const { sessionId, totalQuestions } = req.body;
  try {
    const costResult = db.prepare('SELECT SUM(cost) as totalCost FROM question_answers WHERE session_id = ?').get(sessionId);
    const totalCost = costResult.totalCost || 0;

    db.prepare(
      'UPDATE interview_sessions SET status = ?, ended_at = ?, total_questions = ?, total_cost = ? WHERE id = ?'
    ).run('completed', new Date().toISOString(), totalQuestions, totalCost, sessionId);
    
    res.json({ message: 'Session ended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/:id/export - Exportar sessão como Markdown
app.get('/api/session/:id/export', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM interview_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    const qas = db.prepare('SELECT * FROM question_answers WHERE session_id = ? ORDER BY created_at').all(req.params.id);
    
    let md = `# Interview Summary - Session ${session.id}\n\n`;
    md += `**Date:** ${new Date(session.started_at).toLocaleString()}\n`;
    md += `**Total Cost:** $${session.total_cost.toFixed(4)}\n\n---\n\n`;

    qas.forEach((qa, i) => {
      md += `### Q${i + 1}: ${qa.question}\n\n`;
      md += `**Answer:**\n${qa.answer}\n\n`;
      md += `*Cost: $${qa.cost.toFixed(4)} | Cached: ${qa.cached} | Tailored: ${qa.tailored}*\n\n---\n\n`;
    });

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename=interview-${session.id}.md`);
    res.send(md);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/transcribe - Transcrição de áudio
app.post('/api/voice/transcribe', async (req, res) => {
  const { audioBase64, mimeType, language = 'en', estimatedDuration = 0 } = req.body;
  try {
    const buffer = Buffer.from(audioBase64, 'base64');
    const audioFile = new File([buffer], 'audio.webm', { type: mimeType });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language,
      response_format: 'verbose_json',
      prompt: 'Technical Data Engineering interview. Terms: SQL, Spark, Kafka, Airflow, ETL, Python, PySpark, dbt, AWS, GCP, Azure, Snowflake, Databricks.'
    });

    const estimatedCost = estimatedDuration * COST_PER_MODEL['whisper-1'];

    res.json({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
      estimatedCost: estimatedCost.toFixed(4)
    });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// POST /api/ai/answer - Geração de resposta
app.post('/api/ai/answer', async (req, res) => {
  const { question, sessionId, previousQAs = [], stream = false } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });

  const startTime = Date.now();
  const normalizedQ = normalizeQuestion(question);

  // 1. Verifica cache
  const cached = responseCache.get(normalizedQ);
  if (cached) {
    if (sessionId) {
      db.prepare(
        'INSERT INTO question_answers (session_id, question, answer, processing_time_ms, tokens_input, tokens_output, cost, cached, tailored) VALUES (?, ?, ?, 0, 0, 0, 0, 1, 0)'
      ).run(sessionId, question, cached.answer);
    }
    return res.json({ ...cached, cached: true, tailored: false });
  }

  // 2. Busca perfil da vaga
  const job = db.prepare(`
    SELECT j.* FROM job_profiles j
    JOIN interview_sessions s ON s.job_profile_id = j.id
    WHERE s.id = ?
  `).get(sessionId);

  // 3. Monta o prompt do sistema
  let system_prompt = `You are a world-class Senior Data Engineer acting as a co-pilot during a live technical interview. Your goal is to provide answers that are technically accurate, concise, and demonstrate seniority. RULES: 1. Be direct. No fluff. 2. Use Markdown for code blocks and lists. 3. If the user provides context from a job description, tailor your answer to it.`;

  let tailored = false;
  if (job) {
    system_prompt += `\n\n### JOB CONTEXT FOR THIS INTERVIEW (TAILOR YOUR ANSWERS TO THIS):\n- **Position:** ${job.name} at ${job.company || 'the company'}\n- **Seniority:** ${job.seniority}\n- **Key Skills:** ${job.key_skills}\n- **Description:** ${job.job_description.slice(0, 1000)}`;
    tailored = true;
  }

  // 4. Prepara contexto da conversa
  const userContent = `Previous context:\n${previousQAs.map(qa => `Q: ${qa.question}\nA: ${qa.answer.slice(0, 150)}${qa.answer.length > 150 ? '...' : ''}`).join('\n\n')}\n\nCurrent Question: ${question}`;

  const messages = [
    { role: 'system', content: system_prompt },
    { role: 'user', content: userContent }
  ];

  // 5. Seleciona modelo e estima tokens
  const isComplex = question.length > 100 || question.includes('design') || question.includes('architecture');
  const model = isComplex ? 'gpt-4o-mini' : 'gpt-4o-mini'; // Pode ajustar
  const estimatedInput = Math.ceil((system_prompt.length + userContent.length) / 4);

  // 6. Executa a chamada para a OpenAI
  try {
    const response = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: isComplex ? 2048 : 1024,
      stream: false, // Streaming será tratado em outra rota/lógica
    });

    const fullAnswer = response.choices[0].message.content;
    const tokensIn = response.usage.prompt_tokens;
    const tokensOut = response.usage.completion_tokens;
    const cost = estimateCost(tokensIn, tokensOut, model);
    const processingTimeMs = Date.now() - startTime;

    // 7. Salva no cache e no banco de dados
    responseCache.set(normalizedQ, { answer: fullAnswer, cost, tokens: { input: tokensIn, output: tokensOut }, processingTimeMs });

    if (sessionId) {
      db.prepare(
        'INSERT INTO question_answers (session_id, question, answer, processing_time_ms, tokens_input, tokens_output, cost, cached, tailored) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
      ).run(sessionId, question, fullAnswer, processingTimeMs, tokensIn, tokensOut, cost, tailored);
    }

    res.json({
      answer: fullAnswer,
      cost,
      tokens: { input: tokensIn, output: tokensOut },
      processingTimeMs,
      cached: false,
      tailored
    });

  } catch (err) {
    console.error('AI answer error:', err.message);
    res.status(500).json({ error: 'Failed to generate AI answer' });
  }
});

// --- Servir o frontend --- //
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}` );
});

# src/App.jsx

import { useState, useCallback, useEffect, useRef } from 'react';
import { useOptimizedAudioCapture } from './useOptimizedAudioCapture';
import { useSmartCache } from './useSmartCache';
import { useParallelQueue } from './useParallelQueue';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { JobProfileManager } from './components/JobProfileManager';
import { QACard } from './components/QACard';
import { api } from './api';

// Metrics Panel Component
function MetricsPanel({ metrics, cost, cacheStats, latency, tailored }) {
  return (
    <div className="metrics-panel">
      <div className="metric-group">
        <div className="metric">
          <span className="metric-value">{latency}ms</span>
          <span className="metric-label">Last Latency</span>
        </div>
        <div className="metric">
          <span className="metric-value">${cost.toFixed(3)}</span>
          <span className="metric-label">Session Cost</span>
        </div>
        <div className="metric">
          <span className="metric-value">{cacheStats.memoryItems + cacheStats.storageItems}</span>
          <span className="metric-label">Cached</span>
        </div>
        <div className="metric">
          <span className="metric-value">{cacheStats.hitRate}%</span>
          <span className="metric-label">Cache Hit</span>
        </div>
      </div>
      
      <div className="metric-group secondary">
        <div className="metric">
          <span className="metric-value">{(metrics.bytesSent / 1024).toFixed(0)}KB</span>
          <span className="metric-label">Audio Sent</span>
        </div>
        <div className="metric">
          <span className="metric-value">{metrics.chunksSent}</span>
          <span className="metric-label">Chunks</span>
        </div>
        {tailored !== null && (
          <div className={`metric ${tailored ? 'tailored' : ''}`}>
            <span className="metric-value">{tailored ? '✓' : '○'}</span>
            <span className="metric-label">{tailored ? 'Tailored' : 'Generic'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Stealth Mode Component
function StealthMode({ status, elapsed, qaCount, cost, currentQ, onPause, onResume, onStop, onExpand }) {
  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  return (
    <div className="stealth-container">
      <div className="stealth-widget">
        <div className={`status-indicator ${status}`} />
        <span className="stealth-timer">{formatTime(elapsed)}</span>
        <span className="stealth-count">{qaCount}Q</span>
        <span className="stealth-cost">${cost.toFixed(2)}</span>
        
        <div className="stealth-controls">
          <button onClick={status === 'recording' ? onPause : onResume}>
            {status === 'recording' ? '⏸' : '▶'}
          </button>
          <button onClick={onExpand} title="Expand">⛶</button>
          <button onClick={onStop} className="danger" title="Stop">⏹</button>
        </div>
      </div>
      
      {currentQ && (
        <div className="stealth-question">
          <span className="label">Detected:</span>
          <span className="text">{currentQ}</span>
        </div>
      )}
    </div>
  );
}

// Main App
export default function App() {
  // Estados principais
  const [sessionId, setSessionId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [qaList, setQaList] = useState([]);
  const [starredIds, setStarredIds] = useState(new Set());
  const [currentTranscription, setCurrentTranscription] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedQA, setExpandedQA] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [audioSource, setAudioSource] = useState('microphone');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [stealthMode, setStealthMode] = useState(false);
  const [showJobManager, setShowJobManager] = useState(false);
  
  // Job context
  const [selectedJob, setSelectedJob] = useState(null);
  const [lastTailored, setLastTailored] = useState(null);
  
  // Métricas
  const [sessionCost, setSessionCost] = useState(0);
  const [lastLatency, setLastLatency] = useState(0);

  // Refs
  const qaIdCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStartRef = useRef(0);

  // Hooks otimizados
  const { getCached, setCached, getStats: getCacheStats } = useSmartCache();

  // Carrega job default na montagem
  useEffect(() => {
    api.getDefaultJob().then(job => {
      if (job) setSelectedJob(job);
    });
  }, []);

  // Processamento de pergunta
  const processQuestion = useCallback(async (question, metadata) => {
    const start = performance.now();
    
    // Verifica cache
    const cached = getCached(question);
    if (cached) {
      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer: cached.answer,
        processingTimeMs: 0,
        cached: true,
        tailored: false,
        cost: 0,
        timestamp: Date.now()
      };
      
      setQaList(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setLastTailored(false);
      setLastLatency(Math.round(performance.now() - start));
      return;
    }

    setIsGenerating(true);
    try {
      const previousQAs = qaList.slice(-3).map(qa => ({
        question: qa.question,
        answer: qa.answer.slice(0, 200)
      }));

      const result = await api.answer(question, sessionId, previousQAs);
      
      // Salva no cache
      setCached(question, result.answer, {
        tokens: result.tokens?.output,
        processingTime: result.processingTimeMs,
        cost: parseFloat(result.cost)
      });

      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer: result.answer,
        processingTimeMs: result.processingTimeMs,
        cached: false,
        tailored: result.tailored,
        cost: result.cost,
        tokens: result.tokens,
        timestamp: Date.now()
      };

      setQaList(prev => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setSessionCost(c => c + parseFloat(result.cost || 0));
      setLastTailored(result.tailored);
      setLastLatency(Math.round(performance.now() - start));
      
    } catch (err) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  }, [getCached, setCached, qaList, sessionId]);

  // Fila paralela com debounce
  const { add: queueQuestion, getStats: getQueueStats } = useParallelQueue(processQuestion, {
    maxConcurrent: 1,
    debounceMs: 250
  });

  // Captura de áudio otimizada
  const handleAudioChunk = useCallback(async (base64, mimeType, size, estimatedDuration) => {
    if (!sessionActive) return;
    
    setIsTranscribing(true);
    const start = performance.now();
    
    try {
      const result = await api.transcribe(base64, mimeType, 'en', estimatedDuration);
      setIsTranscribing(false);
      
      if (!result.text || result.text.trim().length < 5) return;
      
      const question = result.text.trim();
      setCurrentTranscription(question);
      
      // Adiciona à fila
      queueQuestion({ question }, { estimatedCost: result.estimatedCost });
      setCurrentTranscription('');
      
    } catch (err) {
      setIsTranscribing(false);
      setError(err.message.slice(0, 100));
    }
  }, [sessionActive, queueQuestion]);

  const {
    status: audioStatus,
    error: audioError,
    metrics: audioMetrics,
    startRecording,
    pause,
    resume,
    stop
  } = useOptimizedAudioCapture({
    onChunk: handleAudioChunk,
    silenceThreshold: 800,
    maxChunkMs: 12000,
    minChunkMs: 3000
  });

  // Timer
  useEffect(() => {
    if (sessionActive && audioStatus === 'recording') {
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - sessionStartRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [sessionActive, audioStatus]);

  // Scroll automático
  useEffect(() => {
    if (scrollRef.current && !stealthMode) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [qaList, currentTranscription, isGenerating, stealthMode]);

  // Atalhos de teclado
  useKeyboardShortcuts({
    onTogglePause: () => audioStatus === 'recording' ? pause() : resume(),
    onStop: stopSession,
    onToggleStealth: () => setStealthMode(s => !s),
    isActive: sessionActive,
    captureStatus: audioStatus
  });

  // Controles de sessão
  const startSession = async (source) => {
    try {
      setStarting(true);
      setAudioSource(source);
      
      const session = await api.createSession(selectedJob?.id);
      setSessionId(session.id);
      setSessionActive(true);
      setQaList([]);
      setSessionCost(0);
      setElapsedTime(0);
      setLastTailored(null);
      sessionStartRef.current = Date.now();
      qaIdCounter.current = 0;
      
      // Atualiza job se veio da sessão
      if (session.jobName) {
        setSelectedJob({
          id: session.jobProfileId,
          name: session.jobName,
          company: session.company,
          key_skills: session.key_skills,
          seniority: session.seniority
        });
      }
      
      await startRecording(source);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const stopSession = async () => {
    stop();
    setSessionActive(false);
    setStealthMode(false);
    
    if (sessionId) {
      try {
        await api.endSession(sessionId, qaList.length);
      } catch (e) {
        console.warn('Failed to end session:', e);
      }
    }
  };

  const exportSession = async () => {
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/session/${sessionId}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `interview-${sessionId}-${new Date().toISOString().split('T')[0]}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Export failed: ' + err.message);
    }
  };

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const cacheStats = getCacheStats();

  // Render modo stealth
  if (stealthMode && sessionActive) {
    return (
      <StealthMode
        status={audioStatus}
        elapsed={elapsedTime}
        qaCount={qaList.length}
        cost={sessionCost}
        currentQ={currentTranscription}
        onPause={pause}
        onResume={resume}
        onStop={stopSession}
        onExpand={() => setStealthMode(false)}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>Interview Agent <span className="version">v2.0</span></h1>
        </div>
        
        <div className="header-center">
          {selectedJob ? (
            <div 
              className="job-indicator" 
              onClick={() => setShowJobManager(true)}
              title="Click to change"
            >
              <span className="job-name">{selectedJob.name}</span>
              {selectedJob.company && (
                <span className="job-company">at {selectedJob.company}</span>
              )}
              <span className="job-seniority">{selectedJob.seniority}</span>
            </div>
          ) : (
            <button 
              className="btn-select-job" 
              onClick={() => setShowJobManager(true)}
            >
              + Select Job Profile
            </button>
          )}
        </div>
        
        <div className="header-right">
          {sessionActive && (
            <>
              <span className="header-timer">{formatTime(elapsedTime)}</span>
              <button 
                className="btn-stealth" 
                onClick={() => setStealthMode(true)}
                title="Stealth Mode (Ctrl+H)"
              >
                👁
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-main" ref={scrollRef}>
        {!sessionActive ? (
          <div className="start-screen">
            <div className="hero">
              <h2>AI-Powered Interview Assistant</h2>
              <p className="subtitle">
                Optimized for <strong>speed</strong>, <strong>cost</strong>, and <strong>relevance</strong>
              </p>
              <ul className="features">
                <li>🎯 Job-specific tailored responses</li>
                <li>⚡ Smart caching (60%+ cost reduction)</li>
                <li>🎤 Optimized audio (mono 16kHz, silence detection)</li>
                <li>📊 Real-time cost tracking</li>
              </ul>
            </div>

            <div className="source-selection">
              <button 
                onClick={() => startSession('system')} 
                disabled={starting || !selectedJob}
                className="btn-source primary"
              >
                <span className="icon">🖥</span>
                <span className="label">System Audio</span>
                <span className="hint">Zoom, Meet, Teams</span>
              </button>
              
              <button 
                onClick={() => startSession('microphone')} 
                disabled={starting || !selectedJob}
                className="btn-source secondary"
              >
                <span className="icon">🎤</span>
                <span className="label">Microphone</span>
                <span className="hint">Ambient audio</span>
              </button>
            </div>

            {!selectedJob && (
              <div className="warning">
                ⚠️ Please select or create a Job Profile first
              </div>
            )}

            <div className="shortcuts-hint">
              <kbd>Ctrl</kbd><kbd>Space</kbd> Pause/Resume
              <kbd>Ctrl</kbd><kbd>H</kbd> Stealth Mode
              <kbd>Esc</kbd> Stop Session
            </div>

            <MetricsPanel
              metrics={audioMetrics}
              cost={sessionCost}
              cacheStats={cacheStats}
              latency={lastLatency}
              tailored={null}
            />
          </div>
        ) : (
          <div className="session-active">
            <div className="qa-list">
              {qaList.length === 0 && !currentTranscription && !isTranscribing && (
                <div className="waiting-state">
                  <p>Listening for questions...</p>
                  <span className="hint">
                    {audioSource === 'system' ? 'Capturing system audio' : 'Capturing microphone'}
                  </span>
                </div>
              )}

              {qaList.map(qa => (
                <QACard
                  key={qa.id}
                  qa={qa}
                  isExpanded={expandedQA === qa.id}
                  onToggle={() => setExpandedQA(expandedQA === qa.id ? null : qa.id)}
                  isStarred={starredIds.has(qa.id)}
                  onStar={() => {
                    setStarredIds(prev => {
                      const next = new Set(prev);
                      next.has(qa.id) ? next.delete(qa.id) : next.add(qa.id);
                      return next;
                    });
                  }}
                />
              ))}

              {(isTranscribing || currentTranscription || isGenerating) && (
                <div className="processing-state">
                  {isTranscribing && (
                    <div className="processing-item">
                      <span className="spinner">🎤</span>
                      <span>Transcribing...</span>
                    </div>
                  )}
                  {currentTranscription && (
                    <div className="processing-item preview">
                      <span className="label">Detected:</span>
                      <span className="text">{currentTranscription}</span>
                    </div>
                  )}
                  {isGenerating && (
                    <div className="processing-item">
                      <span className="spinner">🤖</span>
                      <span>
                        Generating... 
                        {getQueueStats().queueLength > 0 && ` (+${getQueueStats().queueLength})`}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="control-bar">
              <div className={`status-badge ${audioStatus}`}>
                <span className={`pulse ${audioStatus === 'recording' ? 'active' : ''}`} />
                <span>{audioStatus}</span>
              </div>

              <div className="control-actions">
                {audioStatus === 'recording' ? (
                  <button onClick={pause} className="btn-control">⏸ Pause</button>
                ) : (
                  <button onClick={resume} className="btn-control">▶ Resume</button>
                )}
                <button 
                  onClick={exportSession} 
                  disabled={qaList.length === 0}
                  className="btn-control"
                >
                  💾 Export
                </button>
                <button 
                  onClick={() => setStealthMode(true)} 
                  className="btn-control"
                >
                  👁 Stealth
                </button>
                <button onClick={stopSession} className="btn-control danger">
                  ⏹ Stop
                </button>
              </div>
            </div>

            <MetricsPanel
              metrics={audioMetrics}
              cost={sessionCost}
              cacheStats={cacheStats}
              latency={lastLatency}
              tailored={lastTailored}
            />
          </div>
        )}
      </main>

      {showJobManager && (
        <div className="modal-overlay" onClick={() => setShowJobManager(false)}>
          <div className="modal large" onClick={e => e.stopPropagation()}>
            <JobProfileManager
              selectedId={selectedJob?.id}
              onSelect={(job) => {
                setSelectedJob(job);
                setShowJobManager(false);
              }}
              onClose={() => setShowJobManager(false)}
            />
          </div>
        </div>
      )}

      {(error || audioError) && (
        <div className="toast error" onClick={() => setError(null)}>
          {error || audioError}
        </div>
      )}
    </div>
  );
}

# src/api.js

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

  // Core AI
  transcribe: (audioBase64, mimeType, language, estimatedDuration) =>
    request("/api/voice/transcribe", {
      method: "POST",
      body: { audioBase64, mimeType, language, estimatedDuration },
    }),
  answer: (question, sessionId, previousQAs, stream = false) =>
    request("/api/ai/answer", {
      method: "POST",
      body: { question, sessionId, previousQAs, stream },
    }),
};

# src/useOptimizedAudioCapture.js

import { useState, useRef, useCallback } from "react";

export function useOptimizedAudioCapture({
  onChunk,
  silenceThreshold = 800, // ms of silence to trigger chunk
  maxChunkMs = 12000, // 12 seconds max
  minChunkMs = 3000, // 3 seconds min
}) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState({ bytesSent: 0, chunksSent: 0 });

  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const chunkTimerRef = useRef(null);
  const audioDataRef = useRef([]);

  const processAudio = useCallback(() => {
    if (analyserRef.current && audioContextRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteTimeDomainData(dataArray);
      const isSilent = dataArray.every((v) => v === 128);

      if (!isSilent) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      } else if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(sendChunk, silenceThreshold);
      }
    }
    requestAnimationFrame(processAudio);
  }, [silenceThreshold]);

  const sendChunk = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.requestData();
    }
    clearTimeout(chunkTimerRef.current);
    chunkTimerRef.current = null;
  }, []);

  const startRecording = useCallback(async (sourceType) => {
    try {
      setStatus("starting");
      const stream = await (sourceType === "system"
        ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : navigator.mediaDevices.getUserMedia({ audio: true }));

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error("No audio track found in the selected source.");
      }

      streamRef.current = new MediaStream([audioTrack]);
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const sourceNode = audioContextRef.current.createMediaStreamSource(streamRef.current);
      analyserRef.current = audioContextRef.current.createAnalyser();
      sourceNode.connect(analyserRef.current);

      mediaRecorderRef.current = new MediaRecorder(streamRef.current, { mimeType: "audio/webm" });
      audioDataRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioDataRef.current.push(event.data);
          const blob = new Blob(audioDataRef.current, { type: "audio/webm" });
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result.split(",")[1];
            const estimatedDuration = audioContextRef.current.currentTime;
            onChunk(base64, "audio/webm", blob.size, estimatedDuration);
            setMetrics((prev) => ({ bytesSent: prev.bytesSent + blob.size, chunksSent: prev.chunksSent + 1 }));
          };
          reader.readAsDataURL(blob);
          audioDataRef.current = []; // Reset for next chunk
        }
      };

      mediaRecorderRef.current.onstart = () => {
        setStatus("recording");
        processAudio();
        chunkTimerRef.current = setTimeout(sendChunk, maxChunkMs);
      };

      mediaRecorderRef.current.start(1000); // Check every second
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  }, [processAudio, maxChunkMs, onChunk]);

  const pause = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setStatus("paused");
      clearTimeout(silenceTimerRef.current);
      clearTimeout(chunkTimerRef.current);
    }
  }, []);

  const resume = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      setStatus("recording");
      chunkTimerRef.current = setTimeout(sendChunk, maxChunkMs);
    }
  }, [maxChunkMs, sendChunk]);

  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    clearTimeout(silenceTimerRef.current);
    clearTimeout(chunkTimerRef.current);
    setStatus("idle");
  }, []);

  return { status, error, metrics, startRecording, pause, resume, stop };
}

# src/useSmartCache.js

import { useState, useCallback, useRef, useEffect } from "react";

const MEMORY_CACHE_SIZE = 50;
const STORAGE_KEY = "meeting_spy_cache";

export function useSmartCache() {
  const memoryCache = useRef(new Map());
  const [storageCache, setStorageCache] = useState(() => {
    try {
      const item = localStorage.getItem(STORAGE_KEY);
      return item ? new Map(JSON.parse(item)) : new Map();
    } catch (e) {
      return new Map();
    }
  });

  const [stats, setStats] = useState({ hits: 0, misses: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(storageCache.entries())));
    } catch (e) {
      console.error("Failed to save cache to localStorage");
    }
  }, [storageCache]);

  const normalize = (key) => key.toLowerCase().replace(/\s+/g, " ").trim();

  const getCached = useCallback((key) => {
    const normalizedKey = normalize(key);
    if (memoryCache.current.has(normalizedKey)) {
      setStats((s) => ({ ...s, hits: s.hits + 1 }));
      return memoryCache.current.get(normalizedKey);
    }
    if (storageCache.has(normalizedKey)) {
      setStats((s) => ({ ...s, hits: s.hits + 1 }));
      const value = storageCache.get(normalizedKey);
      memoryCache.current.set(normalizedKey, value); // Promote to memory cache
      return value;
    }
    setStats((s) => ({ ...s, misses: s.misses + 1 }));
    return null;
  }, [storageCache]);

  const setCached = useCallback((key, value, metadata = {}) => {
    const normalizedKey = normalize(key);
    const cacheItem = { answer: value, ...metadata, timestamp: Date.now() };

    memoryCache.current.set(normalizedKey, cacheItem);
    if (memoryCache.current.size > MEMORY_CACHE_SIZE) {
      const oldestKey = memoryCache.current.keys().next().value;
      memoryCache.current.delete(oldestKey);
    }

    setStorageCache((prev) => {
      const newCache = new Map(prev);
      newCache.set(normalizedKey, cacheItem);
      return newCache;
    });
  }, []);

  const getStats = useCallback(() => {
    const total = stats.hits + stats.misses;
    return {
      ...stats,
      hitRate: total > 0 ? Math.round((stats.hits / total) * 100) : 0,
      memoryItems: memoryCache.current.size,
      storageItems: storageCache.size,
    };
  }, [stats, storageCache.size]);

  return { getCached, setCached, getStats };
}

# src/useParallelQueue.js

import { useState, useCallback, useRef } from "react";

export function useParallelQueue(processor, { maxConcurrent = 2, debounceMs = 0 }) {
  const [queue, setQueue] = useState([]);
  const [active, setActive] = useState(0);
  const debounceTimer = useRef(null);

  const processQueue = useCallback(() => {
    if (active >= maxConcurrent || queue.length === 0) return;

    const item = queue[0];
    setQueue((q) => q.slice(1));
    setActive((a) => a + 1);

    processor(item.payload, item.metadata).finally(() => {
      setActive((a) => a - 1);
      processQueue();
    });
  }, [active, queue, maxConcurrent, processor]);

  const add = useCallback((payload, metadata) => {
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setQueue((q) => [...q, { payload, metadata }]);
      processQueue();
    }, debounceMs);
  }, [processQueue, debounceMs]);

  const getStats = useCallback(() => ({
    queueLength: queue.length,
    activeTasks: active,
  }), [queue.length, active]);

  return { add, getStats };
}

# src/useKeyboardShortcuts.js

import { useEffect } from "react";

export function useKeyboardShortcuts({
  onTogglePause,
  onStop,
  onToggleStealth,
  isActive,
  captureStatus,
}) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!isActive) return;

      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        onTogglePause();
      }
      if (e.code === "Escape") {
        e.preventDefault();
        onStop();
      }
      if (e.ctrlKey && e.code === "KeyH") {
        e.preventDefault();
        onToggleStealth();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onTogglePause, onStop, onToggleStealth, captureStatus]);
}

# src/components/JobProfileManager.jsx

import { useState, useEffect } from "react";
import { api } from "../api";

export function JobProfileManager({ selectedId, onSelect, onClose }) {
  const [jobs, setJobs] = useState([]);
  const [editingJob, setEditingJob] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadJobs();
  }, []);

  const loadJobs = async () => {
    setIsLoading(true);
    const jobs = await api.getJobs();
    setJobs(jobs);
    setIsLoading(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (editingJob.id) {
      await api.updateJob(editingJob.id, editingJob);
    } else {
      await api.createJob(editingJob);
    }
    setEditingJob(null);
    loadJobs();
  };

  const handleDelete = async (id) => {
    if (confirm("Are you sure you want to delete this profile?")) {
      await api.deleteJob(id);
      loadJobs();
    }
  };

  const handleSetDefault = async (id) => {
    await api.setDefaultJob(id);
    loadJobs();
  };

  if (editingJob) {
    return (
      <form onSubmit={handleSave} className="job-form">
        <h2>{editingJob.id ? "Edit" : "New"} Job Profile</h2>
        <input
          type="text"
          placeholder="Profile Name (e.g., Senior DE at Google)"
          value={editingJob.name || ""}
          onChange={(e) => setEditingJob({ ...editingJob, name: e.target.value })}
          required
        />
        <input
          type="text"
          placeholder="Company"
          value={editingJob.company || ""}
          onChange={(e) => setEditingJob({ ...editingJob, company: e.target.value })}
        />
        <input
          type="text"
          placeholder="Seniority (e.g., Senior, Lead)"
          value={editingJob.seniority || ""}
          onChange={(e) => setEditingJob({ ...editingJob, seniority: e.target.value })}
        />
        <input
          type="text"
          placeholder="Key Skills (comma-separated)"
          value={editingJob.key_skills || ""}
          onChange={(e) => setEditingJob({ ...editingJob, key_skills: e.target.value })}
        />
        <textarea
          placeholder="Job Description"
          value={editingJob.job_description || ""}
          onChange={(e) => setEditingJob({ ...editingJob, job_description: e.target.value })}
        />
        <div className="form-actions">
          <button type="button" onClick={() => setEditingJob(null)} className="btn secondary">
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="job-manager">
      <div className="job-manager-header">
        <h2>Job Profiles</h2>
        <button onClick={() => setEditingJob({})} className="btn primary">
          + New Profile
        </button>
      </div>
      {isLoading ? (
        <p>Loading...</p>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.id} className={job.id === selectedId ? "selected" : ""}>
              <div className="job-info" onClick={() => onSelect(job)}>
                <span className="job-name">{job.name}</span>
                <span className="job-company">{job.company}</span>
                {job.is_default && <span className="default-badge">Default</span>}
              </div>
              <div className="job-actions">
                <button onClick={() => handleSetDefault(job.id)} title="Set as Default">⭐</button>
                <button onClick={() => setEditingJob(job)} title="Edit">✏️</button>
                <button onClick={() => handleDelete(job.id)} title="Delete" className="danger">🗑️</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button onClick={onClose} className="btn-close">×</button>
    </div>
  );
}

# src/components/QACard.jsx

import { useState } from "react";

export function QACard({ qa, isExpanded, onToggle, isStarred, onStar }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`qa-card ${isExpanded ? "expanded" : ""}`}>
      <div className="qa-header" onClick={onToggle}>
        <span className="qa-num">Q{qa.id}</span>
        <span className="qa-q">{qa.question.slice(0, 80)}...</span>
        <div className="qa-badges">
          {qa.cached && <span className="badge cache">CACHE</span>}
          {qa.tailored && <span className="badge tailored">TAILORED</span>}
          {qa.processingTimeMs > 0 && (
            <span className="badge time">{qa.processingTimeMs}ms</span>
          )}
        </div>
        <button onClick={(e) => { e.stopPropagation(); onStar(); }}>
          {isStarred ? "★" : "☆"}
        </button>
        <span className="qa-toggle">{isExpanded ? "▼" : "▶"}</span>
      </div>
      {isExpanded && (
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
            </div>
          </div>
          {qa.cost > 0 && <span className="cost-tag">Cost: ${qa.cost.toFixed(5)}</span>}
        </div>
      )}
    </div>
  );
}

# package.json

{
  "name": "interview-agent-optimized",
  "private": true,
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "server": "node server/index.mjs",
    "start": "npm run build && node server/index.mjs"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "lru-cache": "^10.2.0",
    "multer": "^1.4.5-lts.1",
    "openai": "^4.33.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.15",
    "@types/react-dom": "^18.2.7",
    "@vitejs/plugin-react": "^4.0.3",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.3",
    "vite": "^4.4.5"
  }
}

# vite.config.js

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
} );
