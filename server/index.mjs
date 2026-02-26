// server/index.mjs - Backend completo com Job Profiles
import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "interview-agent.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ─── Database Setup ───
db.exec(`
  CREATE TABLE IF NOT EXISTS job_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    description TEXT NOT NULL,
    key_skills TEXT,
    seniority TEXT CHECK(seniority IN ('junior', 'mid', 'senior', 'staff')),
    focus_areas TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    isDefault BOOLEAN DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS interview_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobProfileId INTEGER,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    totalQuestions INTEGER DEFAULT 0,
    totalCost REAL DEFAULT 0,
    FOREIGN KEY (jobProfileId) REFERENCES job_profiles(id)
  );
  
  CREATE TABLE IF NOT EXISTS question_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    processingTimeMs INTEGER,
    tokensInput INTEGER,
    tokensOutput INTEGER,
    cost REAL,
    cached BOOLEAN DEFAULT 0,
    tailored BOOLEAN DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES interview_sessions(id)
  );
  
  CREATE INDEX IF NOT EXISTS idx_qa_session ON question_answers(sessionId);
  CREATE INDEX IF NOT EXISTS idx_sessions_job ON interview_sessions(jobProfileId);
`);

// ─── OpenAI ───
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY not configured. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Express ───
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ─── LRU Cache ───
class LRUCache {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (item) {
      this.cache.delete(key);
      this.cache.set(key, item);
      this.hits++;
      return item;
    }
    this.misses++;
    return null;
  }
  
  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
  
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total * 100).toFixed(1) : 0
    };
  }
}

const responseCache = new LRUCache(200);

// ─── Prompt Generator ───
const BASE_PROMPT = `You are a senior technical interviewer assistant. Be CONCISE, DIRECT, and PRACTICAL.

Rules:
1. No greetings/fluff - straight to the answer
2. Start with core concept, expand only if needed
3. Always include practical examples (code or architecture)
4. Mention trade-offs and production considerations
5. Use markdown for readability
6. Answer in ENGLISH`;

function generateJobPrompt(job) {
  if (!job) return `${BASE_PROMPT}\n\nFocus: General Data Engineering`;
  
  const skills = JSON.parse(job.key_skills || '[]');
  const areas = JSON.parse(job.focus_areas || '[]');
  
  return `${BASE_PROMPT}

JOB CONTEXT:
- Role: ${job.name} at ${job.company || 'Unknown Company'}
- Seniority Level: ${job.seniority || 'senior'}
- Required Skills: ${skills.join(', ')}

FOCUS AREAS (prioritize in answers):
${areas.map(a => `- ${a}`).join('\n')}

JOB DESCRIPTION:
${job.description.slice(0, 1000)}...

INSTRUCTIONS:
- Emphasize: ${skills.slice(0, 5).join(', ')}
- Use examples from their tech stack
- Match depth to ${job.seniority} level expectations
- Highlight relevant production experience`;
}

// ─── Helpers ───
function normalizeQuestion(q) {
  return q.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
}

function estimateCost(tokensIn, tokensOut, model = 'gpt-4o-mini') {
  const prices = {
    'gpt-4o-mini': { in: 0.15, out: 0.60 },
    'gpt-4o': { in: 2.50, out: 10.00 }
  };
  const p = prices[model] || prices['gpt-4o-mini'];
  return (tokensIn * p.in + tokensOut * p.out) / 1000000;
}

function checkRelevance(question, skills) {
  if (!skills || skills.length === 0) return false;
  const q = question.toLowerCase();
  return skills.some(skill => q.includes(skill.toLowerCase()));
}

// ─── Routes ───

app.get("/api/health", (req, res) => {
  res.json({ ok: true, cache: responseCache.getStats() });
});

app.get("/api/stats", (req, res) => {
  try {
    const sessions = db.prepare("SELECT COUNT(*) as count FROM interview_sessions WHERE status = 'completed'").get();
    const questions = db.prepare("SELECT COUNT(*) as count FROM question_answers").get();
    const costs = db.prepare("SELECT SUM(cost) as total, SUM(CASE WHEN cached THEN 1 ELSE 0 END) as cached FROM question_answers").get();
    const jobs = db.prepare("SELECT COUNT(*) as count FROM job_profiles").get();
    
    res.json({
      sessions: sessions.count,
      questions: questions.count,
      totalCost: costs.total || 0,
      cachedQuestions: costs.cached || 0,
      jobProfiles: jobs.count,
      cacheStats: responseCache.getStats()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Job Profiles ───

app.post("/api/jobs", (req, res) => {
  try {
    const { name, company, description, key_skills, seniority, focus_areas, isDefault } = req.body;
    
    if (isDefault) {
      db.prepare("UPDATE job_profiles SET isDefault = 0").run();
    }
    
    const result = db.prepare(`
      INSERT INTO job_profiles (name, company, description, key_skills, seniority, focus_areas, isDefault)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, 
      company, 
      description, 
      JSON.stringify(key_skills || []), 
      seniority || 'senior', 
      JSON.stringify(focus_areas || []), 
      isDefault ? 1 : 0
    );
    
    res.json({ id: result.lastInsertRowid, name, isDefault: !!isDefault });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jobs", (req, res) => {
  try {
    const jobs = db.prepare("SELECT * FROM job_profiles ORDER BY isDefault DESC, createdAt DESC").all();
    res.json(jobs.map(j => ({
      ...j,
      key_skills: JSON.parse(j.key_skills || '[]'),
      focus_areas: JSON.parse(j.focus_areas || '[]')
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jobs/default", (req, res) => {
  try {
    let job = db.prepare("SELECT * FROM job_profiles WHERE isDefault = 1 LIMIT 1").get();
    if (!job) {
      job = db.prepare("SELECT * FROM job_profiles ORDER BY createdAt DESC LIMIT 1").get();
    }
    
    if (!job) return res.json(null);
    
    res.json({
      ...job,
      key_skills: JSON.parse(job.key_skills || '[]'),
      focus_areas: JSON.parse(job.focus_areas || '[]')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/jobs/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM job_profiles WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sessions ───

app.post("/api/session/create", (req, res) => {
  try {
    const { jobProfileId } = req.body;
    
    let finalJobId = jobProfileId;
    if (!finalJobId) {
      const defaultJob = db.prepare("SELECT id FROM job_profiles WHERE isDefault = 1 LIMIT 1").get();
      if (defaultJob) finalJobId = defaultJob.id;
    }
    
    const result = db.prepare(`
      INSERT INTO interview_sessions (jobProfileId, startedAt, status, totalQuestions)
      VALUES (?, ?, 'active', 0)
    `).run(finalJobId || null, Date.now());
    
    const session = db.prepare(`
      SELECT s.*, j.name as jobName, j.company, j.description, j.key_skills, j.seniority, j.focus_areas
      FROM interview_sessions s
      LEFT JOIN job_profiles j ON s.jobProfileId = j.id
      WHERE s.id = ?
    `).get(result.lastInsertRowid);
    
    console.log(`📋 Session #${session.id}${session.jobName ? ` [${session.jobName}]` : ''}`);
    
    res.json({
      ...session,
      key_skills: session.key_skills ? JSON.parse(session.key_skills) : [],
      focus_areas: session.focus_areas ? JSON.parse(session.focus_areas) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/end", (req, res) => {
  try {
    const { sessionId, totalQuestions } = req.body;
    const costs = db.prepare("SELECT SUM(cost) as total FROM question_answers WHERE sessionId = ?").get(sessionId);
    
    db.prepare(`
      UPDATE interview_sessions 
      SET status = 'completed', endedAt = ?, totalQuestions = ?, totalCost = ?
      WHERE id = ?
    `).run(Date.now(), totalQuestions, costs.total || 0, sessionId);
    
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(sessionId);
    if (session) {
      const duration = Math.round((session.endedAt - session.startedAt) / 60000);
      console.log(`✅ Session #${session.id} | ${duration}min | ${totalQuestions}Q | $${session.totalCost?.toFixed(4)}`);
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Voice & AI ───

app.post("/api/voice/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm", language = "en", estimatedDuration = 0 } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

    const buffer = Buffer.from(audioBase64, "base64");
    const sizeMB = buffer.length / (1024 * 1024);
    
    if (sizeMB > 16) {
      return res.status(400).json({ error: `File too large: ${sizeMB.toFixed(1)}MB` });
    }

    const estimatedCost = (estimatedDuration / 60) * 0.006;

    const audioFile = new File([buffer], "audio.webm", { type: mimeType });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language,
      response_format: "verbose_json",
      prompt: "Technical interview. Common terms: SQL, Spark, Kafka, Airflow, Python, PySpark, dbt, Snowflake, BigQuery, data pipeline, ETL, streaming.",
    });

    res.json({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
      estimatedCost: estimatedCost.toFixed(4)
    });
  } catch (err) {
    console.error("❌ Transcription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai/answer", async (req, res) => {
  try {
    const { question, sessionId, previousQAs = [] } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    const startTime = Date.now();
    const normalizedQ = normalizeQuestion(question);

    // Busca sessão com job context
    const session = db.prepare(`
      SELECT s.*, j.description, j.key_skills, j.seniority, j.focus_areas
      FROM interview_sessions s
      LEFT JOIN job_profiles j ON s.jobProfileId = j.id
      WHERE s.id = ?
    `).get(sessionId);

    // Verifica cache
    const cacheKey = session?.jobProfileId 
      ? `${session.jobProfileId}:${normalizedQ}`
      : normalizedQ;
      
    const cached = responseCache.get(cacheKey);
    if (cached) {
      console.log('⚡ Cache hit');
      
      db.prepare(`
        INSERT INTO question_answers (sessionId, question, answer, processingTimeMs, tokensInput, tokensOutput, cost, cached, tailored)
        VALUES (?, ?, ?, 0, 0, 0, 0, 1, 0)
      `).run(sessionId, question, cached.answer).catch(() => {});
      
      return res.json({ 
        answer: cached.answer, 
        processingTimeMs: 0, 
        cached: true,
        tailored: false
      });
    }

    // Gera prompt específico do job
    const systemPrompt = generateJobPrompt(session);
    const jobSkills = session?.key_skills ? JSON.parse(session.key_skills) : [];
    const isTailored = checkRelevance(question, jobSkills);

    // Contexto otimizado
    let userContent = question;
    if (previousQAs.length > 0) {
      const context = previousQAs.slice(-3)
        .map(qa => `Q: ${qa.question}\nA: ${qa.answer.slice(0, 150)}...`)
        .join("\n\n");
      userContent = `Context:\n${context}\n\nCurrent: ${question}`;
    }

    // Ajusta parâmetros baseado na pergunta
    const isComplex = question.length > 100 || question.includes('design');
    const maxTokens = isComplex ? 2048 : (isTailored ? 1024 : 768);
    const temperature = isTailored ? 0.2 : 0.4;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      max_tokens: maxTokens,
      temperature
    });

    const answer = completion.choices[0]?.message?.content || "";
    const processingTimeMs = Date.now() - startTime;
    const tokens = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const cost = estimateCost(tokens.prompt_tokens, tokens.completion_tokens);

    // Salva no cache
    responseCache.set(cacheKey, answer);

    // Async DB write
    setTimeout(() => {
      db.prepare(`
        INSERT INTO question_answers (sessionId, question, answer, processingTimeMs, tokensInput, tokensOutput, cost, cached, tailored)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, question, answer, processingTimeMs, tokens.prompt_tokens, tokens.completion_tokens, cost, 0, isTailored ? 1 : 0)
        .catch(e => console.warn("DB error:", e));
    }, 0);

    res.json({ 
      answer, 
      processingTimeMs,
      tokens,
      cost: cost.toFixed(6),
      cached: false,
      tailored: isTailored
    });
    
  } catch (err) {
    console.error("❌ Answer error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Export ───

app.get("/api/session/:id/export", (req, res) => {
  try {
    const session = db.prepare(`
      SELECT s.*, j.name as jobName, j.company
      FROM interview_sessions s
      LEFT JOIN job_profiles j ON s.jobProfileId = j.id
      WHERE s.id = ?
    `).get(req.params.id);
    
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    const qas = db.prepare(`
      SELECT * FROM question_answers 
      WHERE sessionId = ? 
      ORDER BY createdAt
    `).all(req.params.id);
    
    const duration = session.endedAt 
      ? Math.round((session.endedAt - session.startedAt) / 60000)
      : Math.round((Date.now() - session.startedAt) / 60000);
    
    const markdown = `# Interview Session #${session.id}

**Job:** ${session.jobName || 'General'} ${session.company ? `at ${session.company}` : ''}
**Date:** ${session.createdAt}
**Duration:** ${duration} minutes
**Questions:** ${session.totalQuestions || qas.length}
**Total Cost:** $${session.totalCost?.toFixed(4) || '0.0000'}

${qas.map((qa, i) => `
## ${i + 1}. ${qa.question}
${qa.cached ? '*(from cache)*' : ''} ${qa.tailored ? '*(tailored to job)*' : ''}

${qa.answer}

*Latency: ${qa.processingTimeMs}ms | Tokens: ${qa.tokensInput || 0}→${qa.tokensOutput || 0} | Cost: $${qa.cost?.toFixed(6) || '0.000000'}*

---
`).join('')}`;

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="interview-${session.id}.md"`);
    res.send(markdown);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───
const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║   ⚡ Interview Agent v2.0 - Job Context        ║
╠════════════════════════════════════════════════╣
║   API:      http://localhost:${PORT}              ║
║   Features: Job Profiles • Smart Cache • Cost  ║
║             Tracking • Tailored Responses      ║
╚════════════════════════════════════════════════╝
  `);
});
