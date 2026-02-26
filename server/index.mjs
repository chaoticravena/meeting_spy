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

// --- Cache Semântico --- //
const semanticCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 60 * 24, // 24 horas
  updateAgeOnGet: true
});

// --- Database --- //
const dbPath = path.join(__dirname, '..', 'data', 'interview-agent.db');
const db = new Database(dbPath);

// --- Setup Tables (Full Relational) ---
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'dist')));

const upload = multer({ storage: multer.memoryStorage() });

// --- Funções de Custo ---
const COST_PER_MODEL = {
  'whisper-1': 0.006 / 60, // por segundo
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};

function estimateCost(tokensIn, tokensOut, model) {
  if (!COST_PER_MODEL[model] || model === 'whisper-1') return 0;
  const { input, output } = COST_PER_MODEL[model];
  return (tokensIn * input) + (tokensOut * output);
}

// --- Funções de Cache ---
function generateSemanticKey(text) {
  // Normaliza: lowercase, remove pontuação, palavras comuns
  const normalized = text
    .toLowerCase()
    .replace(/[.,?!;:'"-]/g, '')
    .replace(/\b(o|a|os|as|um|uma|de|da|do|em|no|na|que|e|ou|para|por)\b/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
  return createHash('md5').update(normalized).digest('hex');
}

// --- API Endpoints: Job Profiles (Mantidos) ---

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

// --- API Endpoints: Sessions (Mantidos) ---

// POST /api/session/create - Iniciar uma nova sessão
app.post('/api/session/create', (req, res) => {
  const { jobId } = req.body;
  try {
    const sessionId = createHash('sha1').update(Date.now().toString() + Math.random()).digest('hex').slice(0, 16);
    db.prepare(
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

// --- API Endpoints: Core AI (Atualizados para Latência/Streaming) ---

// POST /api/voice/transcribe - Transcrição de áudio (Simples)
app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file' });
    }
    
    const audioFile = new File([req.file.buffer], req.file.originalname, { type: req.file.mimetype });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: process.env.DEFAULT_LANGUAGE || 'pt',
      response_format: 'text',
      prompt: 'Technical Data Engineering interview. Terms: SQL, Spark, Kafka, Airflow, ETL, Python, PySpark, dbt, AWS, GCP, Azure, Snowflake, Databricks.'
    });

    const processingTime = Date.now() - startTime;
    const duration = req.body.estimatedDuration ? parseFloat(req.body.estimatedDuration) : 0;
    const estimatedCost = duration * COST_PER_MODEL['whisper-1'];

    res.json({
      text: transcription.trim(),
      processingTime,
      estimatedCost: estimatedCost.toFixed(4)
    });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// POST /api/ai/answer-stream - Geração de resposta com Streaming e Cache Semântico
app.post('/api/ai/answer-stream', async (req, res) => {
  const { question, sessionId, previousQAs = [], maxTokens = 1024, temperature = 0.4 } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });

  const startTime = Date.now();
  const cacheKey = generateSemanticKey(question);

  // 1. Verifica cache semântico
  const cached = semanticCache.get(cacheKey);
  
  // Configura SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (cached) {
    // Retorna do cache via stream simulado para UX consistente
    const words = cached.answer.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join(' ') + ' ';
      res.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
      await new Promise(r => setTimeout(r, 20)); // Delay artificial suave
    }
    
    res.write(`data: ${JSON.stringify({
      type: 'done',
      fullAnswer: cached.answer,
      usage: { cached: true, tokens: { input: 0, output: 0 } },
      tailored: false,
      cost: 0
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

    // Salva no DB marcado como cache
    db.prepare(`
      INSERT INTO question_answers (session_id, question, answer, processing_time_ms, tokens_input, tokens_output, cost, cached, tailored)
      VALUES (?, ?, ?, ?, 0, 0, 0, 1, 0)
    `).run(sessionId, question, cached.answer, Date.now() - startTime);
    
    return;
  }

  // 2. Busca perfil da vaga (para RAG/Contexto)
  const job = db.prepare(`
    SELECT j.* FROM job_profiles j
    JOIN interview_sessions s ON s.job_profile_id = j.id
    WHERE s.id = ?
  `).get(sessionId);

  // 3. Monta o prompt do sistema
  let system_prompt = `You are a world-class Senior Data Engineer acting as a co-pilot during a live technical interview. Your goal is to provide answers that are technically accurate, concise, and demonstrate seniority. RULES: 1. Be direct. No fluff. 2. Use Markdown for code blocks and lists. 3. If the user provides context from a job description, tailor your answer to it.`;

  let tailored = false;
  if (job) {
    system_prompt += `\n\n### JOB CONTEXT FOR THIS INTERVIEW (TAILOR YOUR ANSWERS TO THIS):\n- **Position:** ${job.name} at ${job.company || 'the company'}\n- **Seniority:** ${job.seniority}\n- **Key Skills:** ${job.key_skills}\n- **Description:** ${job.job_description ? job.job_description.slice(0, 1000) : 'N/A'}`;
    tailored = true;
  }

  // 4. Prepara contexto da conversa (Last 3 Q&A)
  const contextMessages = previousQAs.slice(-3).flatMap(qa => [
    { role: 'user', content: qa.question },
    { role: 'assistant', content: qa.answer }
  ]);

  const messages = [
    { role: 'system', content: system_prompt },
    ...contextMessages,
    { role: 'user', content: question }
  ];

  // 5. Executa a chamada para a OpenAI com Streaming
  try {
    const model = 'gpt-4o-mini'; // Modelo fixo para custo/velocidade
    
    const stream = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature,
      stream: true
    });

    let fullAnswer = '';
    let tokensOut = 0;
    let tokensIn = 0; // Será atualizado após a primeira resposta se o modelo retornar usage

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnswer += content;
        tokensOut++;
        
        res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        if (res.flush) res.flush();
      }
    }
    
    // Estimativa de tokens de entrada (simples, baseado em caracteres)
    tokensIn = Math.ceil(messages.reduce((acc, msg) => acc + msg.content.length, 0) / 4);
    const cost = estimateCost(tokensIn, tokensOut, model);
    const processingTimeMs = Date.now() - startTime;

    // 6. Salva no cache e no banco de dados
    semanticCache.set(cacheKey, { answer: fullAnswer, cost, tokens: { input: tokensIn, output: tokensOut }, processingTimeMs });

    if (sessionId) {
      db.prepare(
        'INSERT INTO question_answers (session_id, question, answer, processing_time_ms, tokens_input, tokens_output, cost, cached, tailored) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
      ).run(sessionId, question, fullAnswer, processingTimeMs, tokensIn, tokensOut, cost, tailored);
    }

    // Finaliza stream
    res.write(`data: ${JSON.stringify({
      type: 'done',
      fullAnswer,
      usage: { cached: false, tokens: { input: tokensIn, output: tokensOut } },
      tailored,
      cost
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
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
