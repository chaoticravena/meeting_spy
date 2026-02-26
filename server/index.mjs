// server/index.mjs - Backend otimizado completo
import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "interview-agent.db");

// ─── Environment ───
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY not configured");
  process.exit(1);
}

// ─── Database ───
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // Performance over durability para cache

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS interview_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    totalQuestions INTEGER NOT NULL DEFAULT 0,
    totalCost REAL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
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
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES interview_sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_qa_session ON question_answers(sessionId);
  CREATE INDEX IF NOT EXISTS idx_qa_created ON question_answers(createdAt);
`);

// ─── OpenAI ───
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Server Cache (LRU) ───
class LRUCache {
  constructor(maxSize = 100) {
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
const embeddingCache = new LRUCache(500);

// ─── Express ───
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // Reduzido de 50mb

// ─── System Prompt ───
const SYSTEM_PROMPT = `You are a senior Data Engineering expert. Answer in ENGLISH.

Rules:
1. Be DIRECT and CONCISE - this is a live interview
2. Start with the core answer, details only if needed
3. Code examples: short and practical
4. Mention trade-offs when relevant
5. No greetings/fluff - get to the point
6. Use markdown for readability
7. For system design: requirements → architecture → components → trade-offs

Expertise: SQL, Spark, Kafka, Airflow, Python, Cloud (AWS/GCP/Azure), Data Lakes, ETL/ELT, dbt, Streaming.`;

// ─── Helpers ───
function estimateCost(tokensIn, tokensOut, model = 'gpt-4o-mini') {
  // Preços por 1M tokens (atualizar conforme OpenAI)
  const prices = {
    'gpt-4o-mini': { in: 0.15, out: 0.60 },
    'gpt-4o': { in: 2.50, out: 10.00 },
    'gpt-3.5-turbo': { in: 0.50, out: 1.50 }
  };
  const p = prices[model] || prices['gpt-4o-mini'];
  return (tokensIn * p.in + tokensOut * p.out) / 1000000;
}

function normalizeQuestion(q) {
  return q.toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
}

// ─── Routes ───

app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: Date.now(),
    cache: responseCache.getStats()
  });
});

app.get("/api/stats", (req, res) => {
  try {
    const sessions = db.prepare("SELECT COUNT(*) as count FROM interview_sessions WHERE status = 'completed'").get();
    const questions = db.prepare("SELECT COUNT(*) as count FROM question_answers").get();
    const costs = db.prepare("SELECT SUM(cost) as total, SUM(CASE WHEN cached THEN 1 ELSE 0 END) as cached FROM question_answers").get();
    
    res.json({
      sessions: sessions.count,
      questions: questions.count,
      totalCost: costs.total || 0,
      cachedQuestions: costs.cached || 0,
      cacheStats: responseCache.getStats()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/create", (req, res) => {
  try {
    const result = db.prepare(
      "INSERT INTO interview_sessions (startedAt, status, totalQuestions) VALUES (?, 'active', 0)"
    ).run(Date.now());
    
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(result.lastInsertRowid);
    console.log(`📋 Session #${session.id} started`);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/end", (req, res) => {
  try {
    const { sessionId, totalQuestions } = req.body;
    const costs = db.prepare("SELECT SUM(cost) as total FROM question_answers WHERE sessionId = ?").get(sessionId);
    
    db.prepare(
      "UPDATE interview_sessions SET status = 'completed', endedAt = ?, totalQuestions = ?, totalCost = ? WHERE id = ?"
    ).run(Date.now(), totalQuestions, costs.total || 0, sessionId);
    
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(sessionId);
    if (session) {
      const duration = Math.round((session.endedAt - session.startedAt) / 60000);
      console.log(`✅ Session #${session.id} ended | ${duration}min | ${totalQuestions}Q | $${session.totalCost?.toFixed(4) || 0}`);
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/voice/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm", language = "en", estimatedDuration = 0 } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "audioBase64 required" });

    const buffer = Buffer.from(audioBase64, "base64");
    const sizeMB = buffer.length / (1024 * 1024);
    
    if (sizeMB > 16) {
      return res.status(400).json({ error: `File too large: ${sizeMB.toFixed(1)}MB` });
    }

    // Estimativa de custo Whisper: $0.006/minuto
    const estimatedCost = (estimatedDuration / 60) * 0.006;

    const audioFile = new File([buffer], "audio.webm", { type: mimeType });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language,
      response_format: "verbose_json",
      prompt: "Technical Data Engineering interview. Terms: SQL, Spark, Kafka, Airflow, ETL, Python, PySpark, dbt, Snowflake, BigQuery.",
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
    const { question, sessionId, previousQAs = [], stream = false } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    const startTime = Date.now();
    const normalizedQ = normalizeQuestion(question);
    
    // 1. Verifica cache
    const cached = responseCache.get(normalizedQ);
    if (cached) {
      console.log('⚡ Cache hit');
      
      if (sessionId) {
        db.prepare(
          "INSERT INTO question_answers (sessionId, question, answer, processingTimeMs, tokensInput, tokensOutput, cost, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(sessionId, question, cached.answer, 0, 0, 0, 0, 1).catch(() => {});
      }
      
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ chunk: cached.answer })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, cached: true })}\n\n`);
        res.end();
      } else {
        res.json({ answer: cached.answer, processingTimeMs: 0, cached: true });
      }
      return;
    }

    // 2. Prepara contexto otimizado (últimas 3, truncadas)
    let userContent = question;
    if (previousQAs.length > 0) {
      const context = previousQAs.slice(-3)
        .map(qa => `Q: ${qa.question}\nA: ${qa.answer.slice(0, 150)}${qa.answer.length > 150 ? '...' : ''}`)
        .join("\n\n");
      userContent = `Previous context:\n${context}\n\nCurrent: ${question}`;
    }

    // 3. Seleciona modelo por complexidade
    const isComplex = question.length > 100 || 
                      question.includes('design') || 
                      question.includes('architecture');
    const model = isComplex ? 'gpt-4o-mini' : 'gpt-4o-mini'; // Pode ajustar

    // 4. Estima tokens para logging
    const estimatedInput = Math.ceil((SYSTEM_PROMPT.length + userContent.length) / 4);

    if (stream) {
      // Streaming para UX mais rápida
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const streamResponse = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: isComplex ? 2048 : 1024,
        stream: true,
      });

      let fullAnswer = '';
      let tokensOut = 0;
      
      for await (const chunk of streamResponse) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullAnswer += content;
        tokensOut += content.length > 0 ? Math.ceil(content.length / 4) : 0;
        
        res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
      }

      const processingTimeMs = Date.now() - startTime;
      const cost = estimateCost(estimatedInput, tokensOut, model);
      
      // Salva no cache
      responseCache.set(normalizedQ, fullAnswer);
      
      // Async DB write
      if (sessionId) {
        db.prepare(
          "INSERT INTO question_answers (sessionId, question, answer, processingTimeMs, tokensInput, tokensOutput, cost, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(sessionId, question, fullAnswer, processingTimeMs, estimatedInput, tokensOut, cost, 0).catch(() => {});
      }
      
      res.write(`data: ${JSON.stringify({ done: true, processingTimeMs, cost: cost.toFixed(6) })}\n\n`);
      res.end();
      
    } else {
      // Non-streaming (mais simples)
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: isComplex ? 2048 : 1024,
      });

      const answer = completion.choices[0]?.message?.content || "";
      const processingTimeMs = Date.now() - startTime;
      const tokensIn = completion.usage?.prompt_tokens || estimatedInput;
      const tokensOut = completion.usage?.completion_tokens || 0;
      const cost = estimateCost(tokensIn, tokensOut, model);

      // Salva no cache
      responseCache.set(normalizedQ, answer);

      // Async DB write
      if (sessionId) {
        setTimeout(() => {
          db.prepare(
            "INSERT INTO question_answers (sessionId, question, answer, processingTimeMs, tokensInput, tokensOutput, cost, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(sessionId, question, answer, processingTimeMs, tokensIn, tokensOut, cost, 0).catch(e => console.warn("DB error:", e));
        }, 0);
      }

      res.json({ 
        answer, 
        processingTimeMs, 
        tokens: { input: tokensIn, output: tokensOut },
        cost: cost.toFixed(6),
        cached: false
      });
    }
  } catch (err) {
    console.error("❌ Answer error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/session/:id/export", (req, res) => {
  try {
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    const qas = db.prepare("SELECT * FROM question_answers WHERE sessionId = ? ORDER BY createdAt").all(req.params.id);
    
    const duration = session.endedAt 
      ? Math.round((session.endedAt - session.startedAt) / 60000)
      : Math.round((Date.now() - session.startedAt) / 60000);
    
    const markdown = `# Interview Session #${session.id}

**Date:** ${session.createdAt}
**Duration:** ${duration} minutes
**Questions:** ${session.totalQuestions || qas.length}
**Total Cost:** $${session.totalCost?.toFixed(4) || '0.0000'}

${qas.map((qa, i) => `
## ${i + 1}. ${qa.question}
${qa.cached ? '*(from cache)*' : ''}

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
╔══════════════════════════════════════════╗
║   ⚡ Interview Agent - Optimized         ║
╠══════════════════════════════════════════╣
║   API:      http://localhost:${PORT}        ║
║   Cache:    LRU (200 items)             ║
║   DB:       WAL mode enabled             ║
╚══════════════════════════════════════════╝
  `);
});
