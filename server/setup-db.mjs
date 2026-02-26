import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "interview-agent.db");

// Ensure data directory exists
import { mkdirSync } from "fs";
mkdirSync(join(__dirname, "..", "data"), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

db.exec(`
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

console.log("✅ Banco de dados criado com sucesso em:", DB_PATH);
db.close();
