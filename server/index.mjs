// server/setup-db.mjs - Setup do banco de dados (executar uma vez)
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "interview-agent.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

console.log("📦 Setting up database...");

// Create tables
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
    followUpQuestion TEXT,
    cloudCostEstimate TEXT,
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

console.log("✅ Database setup complete");

// Migration: Add new columns if they don't exist (for existing databases)
const tableInfo = db.prepare("PRAGMA table_info(question_answers)").all();
const hasFollowUp = tableInfo.some(col => col.name === 'followUpQuestion');
const hasCostEstimate = tableInfo.some(col => col.name === 'cloudCostEstimate');

if (!hasFollowUp || !hasCostEstimate) {
  console.log("🔄 Migrating database to v2.1...");
  
  if (!hasFollowUp) {
    db.prepare("ALTER TABLE question_answers ADD COLUMN followUpQuestion TEXT").run();
    console.log("  + Added followUpQuestion column");
  }
  
  if (!hasCostEstimate) {
    db.prepare("ALTER TABLE question_answers ADD COLUMN cloudCostEstimate TEXT").run();
    console.log("  + Added cloudCostEstimate column");
  }
  
  console.log("✅ Migration complete");
}

db.close();
console.log("📦 Database ready");
