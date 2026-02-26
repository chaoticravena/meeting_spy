// server/setup-db.mjs
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "interview-agent.db"));

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

// Check if we need to migrate old data
const hasOldTable = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name='interview_sessions'
`).get();

if (hasOldTable) {
  // Check if jobProfileId column exists
  const tableInfo = db.prepare("PRAGMA table_info(interview_sessions)").all();
  const hasJobProfileId = tableInfo.some(col => col.name === 'jobProfileId');
  
  if (!hasJobProfileId) {
    console.log("🔄 Migrating database to v2.0...");
    
    // Backup old data
    db.exec(`
      ALTER TABLE interview_sessions RENAME TO interview_sessions_old;
      ALTER TABLE question_answers RENAME TO question_answers_old;
    `);
    
    // Recreate with new schema
    db.exec(`
      CREATE TABLE interview_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jobProfileId INTEGER,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        totalQuestions INTEGER DEFAULT 0,
        totalCost REAL DEFAULT 0,
        createdAt TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (jobProfileId) REFERENCES job_profiles(id)
      );
      
      CREATE TABLE question_answers (
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
    `);
    
    // Migrate data
    db.exec(`
      INSERT INTO interview_sessions (id, status, startedAt, endedAt, totalQuestions, createdAt)
      SELECT id, status, startedAt, endedAt, totalQuestions, createdAt 
      FROM interview_sessions_old;
      
      INSERT INTO question_answers (id, sessionId, question, answer, processingTimeMs, createdAt)
      SELECT id, sessionId, question, answer, processingTimeMs, createdAt 
      FROM question_answers_old;
    `);
    
    // Drop old tables
    db.exec(`
      DROP TABLE interview_sessions_old;
      DROP TABLE question_answers_old;
    `);
    
    console.log("✅ Migration complete");
  }
}

db.close();
console.log("📦 Database ready");
