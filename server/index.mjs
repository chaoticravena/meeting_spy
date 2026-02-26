import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "interview-agent.db");

// ─── Validate Environment ───
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY não configurada. Copie .env.example para .env e preencha sua chave.");
  process.exit(1);
}

// ─── Ensure data dir & DB exist ───
mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(DB_PATH)) {
  console.log("📦 Banco de dados não encontrado. Criando...");
  const setupDb = new Database(DB_PATH);
  setupDb.pragma("journal_mode = WAL");
  setupDb.exec(`
    CREATE TABLE IF NOT EXISTS interview_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
      startedAt INTEGER NOT NULL,
      endedAt INTEGER,
      totalQuestions INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS question_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      processingTimeMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (sessionId) REFERENCES interview_sessions(id)
    );
  `);
  setupDb.close();
  console.log("✅ Banco de dados criado.");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ─── OpenAI Client ───
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Express App ───
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// ─── System Prompt ───
const DATA_ENGINEERING_SYSTEM_PROMPT = `You are a senior Data Engineering expert with over 15 years of experience. You are helping someone during a live Data Engineering technical interview.

Your areas of expertise include:
- **Advanced SQL**: CTEs, window functions, query optimization, indexing, partitioning
- **Python for data**: PySpark, Pandas, Polars, Dask, NumPy
- **Apache Spark**: architecture, optimization, Spark SQL, Structured Streaming, tuning
- **Orchestration**: Apache Airflow, Dagster, Prefect, Luigi, Mage
- **Data Warehousing**: Snowflake, BigQuery, Redshift, Databricks, dimensional modeling (Kimball/Inmon)
- **Streaming**: Apache Kafka, Kinesis, Flink, Spark Streaming, event-driven architecture
- **Cloud**: AWS (S3, Glue, EMR, Athena, Lambda, Step Functions), GCP (BigQuery, Dataflow, Pub/Sub), Azure (Data Factory, Synapse, Databricks)
- **Data Lakes & Lakehouses**: Delta Lake, Apache Iceberg, Apache Hudi, medallion architecture
- **ETL/ELT**: design patterns, data quality, data lineage, data contracts
- **DevOps for data**: CI/CD, IaC (Terraform), Docker, Kubernetes, observability
- **Governance**: data catalog, data mesh, data quality frameworks (Great Expectations, Soda)
- **Modeling**: star schema, snowflake schema, OBT, data vault, SCD types
- **Databases**: PostgreSQL, MySQL, MongoDB, Cassandra, DynamoDB, Redis, ClickHouse
- **Modern tools**: dbt, Fivetran, Airbyte, Stitch, Monte Carlo, Atlan

IMPORTANT RULES:
1. Answer DIRECTLY and CONCISELY - the person is in a live interview
2. ALWAYS respond in ENGLISH, regardless of the question language
3. Start with the main answer and add details only if necessary
4. For coding questions, provide practical and short examples
5. Mention trade-offs and best practices when relevant
6. If the question is about system design, structure: requirements → architecture → components → trade-offs
7. No greetings or farewells - get straight to the point
8. Use markdown formatting for quick reading
9. If you detect the question is about a specific scenario, give the most practical answer possible

Remember: The interviewer may be testing the candidate's English communication skills, so your response MUST be in English.`;

// ─── API Routes ───

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Create session
app.post("/api/session/create", (req, res) => {
  try {
    const stmt = db.prepare("INSERT INTO interview_sessions (startedAt, status, totalQuestions) VALUES (?, 'active', 0)");
    const result = stmt.run(Date.now());
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(result.lastInsertRowid);
    console.log(`📋 Session #${session.id} started`);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End session
app.post("/api/session/end", (req, res) => {
  try {
    const { sessionId, totalQuestions } = req.body;
    db.prepare("UPDATE interview_sessions SET status = 'completed', endedAt = ?, totalQuestions = ? WHERE id = ?")
      .run(Date.now(), totalQuestions, sessionId);
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(sessionId);
    if (session) {
      const durationMin = Math.round((session.endedAt - session.startedAt) / 60000);
      console.log(`✅ Session #${session.id} ended | Duration: ${durationMin}min | Questions: ${totalQuestions}`);
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session
app.get("/api/session/:id", (req, res) => {
  try {
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(req.params.id);
    res.json(session || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List sessions
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.prepare("SELECT * FROM interview_sessions ORDER BY createdAt DESC LIMIT 50").all();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Q&As for session
app.get("/api/session/:id/qas", (req, res) => {
  try {
    const qas = db.prepare("SELECT * FROM question_answers WHERE sessionId = ? ORDER BY createdAt").all(req.params.id);
    res.json(qas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export session to markdown
app.get("/api/session/:id/export", (req, res) => {
  try {
    const session = db.prepare("SELECT * FROM interview_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    const qas = db.prepare("SELECT * FROM question_answers WHERE sessionId = ? ORDER BY createdAt").all(req.params.id);
    
    const duration = session.endedAt 
      ? Math.round((session.endedAt - session.startedAt) / 60000)
      : Math.round((Date.now() - session.startedAt) / 60000);
    
    const markdown = `# Interview Session #${session.id} - ${session.createdAt}

**Status:** ${session.status}
**Duration:** ${duration} minutes
**Total Questions:** ${session.totalQuestions || qas.length}

${qas.map((qa, i) => `
## ${i + 1}. ${qa.question}

${qa.answer}

*Processing time: ${qa.processingTimeMs}ms*

---
`).join('')}`;

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="interview-${session.id}-${session.createdAt.split('T')[0]}.md"`);
    res.send(markdown);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transcribe audio
app.post("/api/voice/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm", language = "pt" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "audioBase64 is required" });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Check size
    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > 16) {
      return res.status(400).json({ error: `File too large: ${sizeMB.toFixed(1)}MB (max 16MB)` });
    }

    // Create a File object for OpenAI
    const audioFile = new File([audioBuffer], "audio.webm", { type: mimeType });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: language,
      response_format: "verbose_json",
      prompt: "Transcribe the technical question from a Data Engineering interview. Common technical terms: SQL, Spark, Kafka, Airflow, ETL, pipeline, data lake, data warehouse, Python, PySpark, dbt, Snowflake, BigQuery, Redshift, Delta Lake, Iceberg.",
    });

    res.json({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
    });
  } catch (err) {
    console.error("❌ Transcription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate AI answer
app.post("/api/ai/answer", async (req, res) => {
  try {
    const { question, sessionId, previousQAs = [] } = req.body;

    if (!question) {
      return res.status(400).json({ error: "question is required" });
    }

    const startTime = Date.now();

    // Build context
    let userContent = "";
    if (previousQAs.length > 0) {
      const recentQAs = previousQAs.slice(-5);
      const context = recentQAs
        .map((qa) => `Previous question: ${qa.question}\nAnswer given: ${qa.answer}`)
        .join("\n\n");
      userContent = `Context from previous interview questions:\n${context}\n\nCurrent interviewer question:\n${question}`;
    } else {
      userContent = `Interviewer question:\n${question}`;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: DATA_ENGINEERING_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 4096,
    });

    const answer = completion.choices[0]?.message?.content || "";
    const processingTimeMs = Date.now() - startTime;

    // Save to DB
    if (sessionId) {
      try {
        db.prepare("INSERT INTO question_answers (sessionId, question, answer, processingTimeMs) VALUES (?, ?, ?, ?)")
          .run(sessionId, question, answer, processingTimeMs);
      } catch (e) {
        console.warn("⚠️ Failed to save Q&A:", e.message);
      }
    }

    res.json({ answer, processingTimeMs });
  } catch (err) {
    console.error("❌ Answer generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───
const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   ⚡ Interview Agent - Local Server    ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║   API:      http://localhost:${PORT}        ║`);
  console.log(`║   Frontend: http://localhost:5173        ║`);
  console.log("║   Database: ./data/interview-agent.db   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
});
