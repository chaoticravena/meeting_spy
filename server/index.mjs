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
const DATA_ENGINEERING_SYSTEM_PROMPT = `Você é um especialista sênior em Engenharia de Dados com mais de 15 anos de experiência. Você está ajudando alguém durante uma entrevista técnica de Engenharia de Dados.

Suas áreas de expertise incluem:
- **SQL avançado**: CTEs, window functions, query optimization, indexação, particionamento
- **Python para dados**: PySpark, Pandas, Polars, Dask, NumPy
- **Apache Spark**: arquitetura, otimização, Spark SQL, Structured Streaming, tuning
- **Orquestração**: Apache Airflow, Dagster, Prefect, Luigi, Mage
- **Data Warehousing**: Snowflake, BigQuery, Redshift, Databricks, modelagem dimensional (Kimball/Inmon)
- **Streaming**: Apache Kafka, Kinesis, Flink, Spark Streaming, event-driven architecture
- **Cloud**: AWS (S3, Glue, EMR, Athena, Lambda, Step Functions), GCP (BigQuery, Dataflow, Pub/Sub), Azure (Data Factory, Synapse, Databricks)
- **Data Lakes & Lakehouses**: Delta Lake, Apache Iceberg, Apache Hudi, medallion architecture
- **ETL/ELT**: design patterns, data quality, data lineage, data contracts
- **DevOps para dados**: CI/CD, IaC (Terraform), Docker, Kubernetes, observabilidade
- **Governança**: data catalog, data mesh, data quality frameworks (Great Expectations, Soda)
- **Modelagem**: star schema, snowflake schema, OBT, data vault, SCD types
- **Bancos de dados**: PostgreSQL, MySQL, MongoDB, Cassandra, DynamoDB, Redis, ClickHouse
- **Ferramentas modernas**: dbt, Fivetran, Airbyte, Stitch, Monte Carlo, Atlan

REGRAS IMPORTANTES:
1. Responda de forma DIRETA e CONCISA - a pessoa está em uma entrevista ao vivo
2. Use português brasileiro
3. Comece com a resposta principal e depois adicione detalhes se necessário
4. Para perguntas de código, forneça exemplos práticos e curtos
5. Mencione trade-offs e boas práticas quando relevante
6. Se a pergunta for sobre system design, estruture: requisitos → arquitetura → componentes → trade-offs
7. Não use saudações ou despedidas - vá direto ao ponto
8. Formate com markdown para facilitar a leitura rápida
9. Se detectar que a pergunta é sobre um cenário específico, dê a resposta mais prática possível`;

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
    console.log(`📋 Sessão #${session.id} iniciada`);
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
      console.log(`✅ Sessão #${session.id} finalizada | Duração: ${durationMin}min | Perguntas: ${totalQuestions}`);
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

// Transcribe audio
app.post("/api/voice/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm", language = "pt" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "audioBase64 é obrigatório" });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Check size
    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > 16) {
      return res.status(400).json({ error: `Arquivo muito grande: ${sizeMB.toFixed(1)}MB (máximo 16MB)` });
    }

    // Create a File object for OpenAI
    const audioFile = new File([audioBuffer], "audio.webm", { type: mimeType });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: language,
      response_format: "verbose_json",
      prompt: "Transcreva a pergunta técnica de uma entrevista de Engenharia de Dados. Termos técnicos comuns: SQL, Spark, Kafka, Airflow, ETL, pipeline, data lake, data warehouse, Python, PySpark, dbt, Snowflake, BigQuery, Redshift, Delta Lake, Iceberg.",
    });

    res.json({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
    });
  } catch (err) {
    console.error("❌ Erro na transcrição:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate AI answer
app.post("/api/ai/answer", async (req, res) => {
  try {
    const { question, sessionId, previousQAs = [] } = req.body;

    if (!question) {
      return res.status(400).json({ error: "question é obrigatória" });
    }

    const startTime = Date.now();

    // Build context
    let userContent = "";
    if (previousQAs.length > 0) {
      const recentQAs = previousQAs.slice(-5);
      const context = recentQAs
        .map((qa) => `Pergunta anterior: ${qa.question}\nResposta dada: ${qa.answer}`)
        .join("\n\n");
      userContent = `Contexto das perguntas anteriores da entrevista:\n${context}\n\nPergunta atual do entrevistador:\n${question}`;
    } else {
      userContent = `Pergunta do entrevistador:\n${question}`;
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
        console.warn("⚠️ Falha ao salvar Q&A:", e.message);
      }
    }

    res.json({ answer, processingTimeMs });
  } catch (err) {
    console.error("❌ Erro na geração de resposta:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───
const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   ⚡ Interview Agent - Servidor Local    ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║   API:      http://localhost:${PORT}        ║`);
  console.log(`║   Frontend: http://localhost:5173        ║`);
  console.log("║   Banco:    ./data/interview-agent.db   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
});
