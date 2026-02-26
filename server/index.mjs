// server/index.mjs - Servidor Express completo
import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "interview-agent.db");

// ─── Database Connection ───
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ─── OpenAI ───
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY not configured");
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

// ─── Cloud Pricing Database ───
const CLOUD_PRICING = {
  aws: {
    kinesis_data_streams: { shard_hour: 0.015, put_payload_unit: 0.014 },
    kinesis_firehose: { data_ingestion: 0.029, format_conversion: 0.018 },
    lambda: { request: 0.20, duration: 0.0000166667 },
    s3: { storage_standard: 0.023, storage_ia: 0.0125, requests_get: 0.0004, requests_put: 0.005 },
    glue: { crawler: 0.44, job: 0.44, interactive_sessions: 0.44 },
    emr: { emr_6_x: 0.096, emr_serverless: 0.052624 },
    athena: { query: 5.00, workgroup: 0 },
    redshift: { ra3_xlplus: 1.086, serverless: 0.36, managed_storage: 0.024 },
    msk: { kafka_m5_large: 0.186, storage: 0.10 },
    step_functions: { standard: 0.025, express: 1.00 },
    eventbridge: { event: 1.00, api_destinations: 1.00 }
  },
  gcp: {
    bigquery: { storage: 0.020, long_term_storage: 0.010, query_on_demand: 5.00, query_flat_rate: 1700.00 },
    pubsub: { data: 0.040, storage: 0.27 },
    dataflow: { vcpu_hour: 0.056, memory_gb_hour: 0.003557, pd_ssd_gb_hour: 0.000298 },
    cloud_functions: { invocation: 0.40, cpu: 0.0001, memory: 0.0001, networking: 0.12 },
    composer: { environment: 0.35 }
  },
  azure: {
    synapse: { sql_pool: 1.51, spark_pool: 0.15, data_explorer: 0.342 },
    event_hubs: { throughput_unit: 0.015, capture: 0.10 },
    databricks: { jobs_compute: 0.15, all_purpose: 0.40, serverless_sql: 0.22, sql_pro: 0.35 }
  },
  snowflake: {
    compute: { standard: 2.00, enterprise: 3.00, business_critical: 4.00 },
    storage: 0.023
  },
  databricks: {
    jobs_workload: 0.10, interactive: 0.15, sql_serverless: 0.22, sql_pro: 0.35
  },
  confluent: {
    basic: 0.10, standard: 0.25, dedicated: 0.50
  }
};

// ─── Cloud Cost Functions ───
function extractServicesFromText(text) {
  const mentioned = [];
  const text_lower = text.toLowerCase();
  
  const serviceAliases = {
    "kinesis": "aws.kinesis_data_streams",
    "firehose": "aws.kinesis_firehose",
    "lambda": "aws.lambda",
    "s3": "aws.s3",
    "glue": "aws.glue",
    "emr": "aws.emr",
    "athena": "aws.athena",
    "redshift": "aws.redshift",
    "msk": "aws.msk",
    "kafka": "aws.msk",
    "step functions": "aws.step_functions",
    "eventbridge": "aws.eventbridge",
    "bigquery": "gcp.bigquery",
    "pubsub": "gcp.pubsub",
    "pub/sub": "gcp.pubsub",
    "dataflow": "gcp.dataflow",
    "cloud functions": "gcp.cloud_functions",
    "composer": "gcp.composer",
    "airflow": "gcp.composer",
    "synapse": "azure.synapse",
    "event hubs": "azure.event_hubs",
    "databricks": "azure.databricks",
    "snowflake": "snowflake.compute",
    "confluent": "confluent.basic"
  };
  
  for (const [alias, serviceKey] of Object.entries(serviceAliases)) {
    if (text_lower.includes(alias) && !mentioned.includes(serviceKey)) {
      mentioned.push(serviceKey);
    }
  }
  
  return mentioned;
}

function extractDataVolume(text) {
  const patterns = [
    { regex: /(\d+(?:\.\d+)?)\s*(TB|tb)\s*(?:per\s*month|\/month|monthly)?/i, unit: 'TB', monthly: true },
    { regex: /(\d+(?:\.\d+)?)\s*(GB|gb)\s*(?:per\s*day|\/day|daily)?/i, unit: 'GB', daily: true },
    { regex: /(\d+(?:\.\d+)?)\s*(GB|gb)\s*(?:per\s*month|\/month|monthly)?/i, unit: 'GB', monthly: true },
    { regex: /(\d+(?:\.\d+)?)\s*(million|m)\s*records?/i, unit: 'M_records', monthly: true },
    { regex: /(\d+(?:\.\d+)?)\s*(billion|b)\s*records?/i, unit: 'B_records', monthly: true }
  ];
  
  let volumeTB = 1;
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const value = parseFloat(match[1]);
      
      if (pattern.unit === 'TB') {
        volumeTB = value;
      } else if (pattern.unit === 'GB' && pattern.daily) {
        volumeTB = value * 30 / 1000;
      } else if (pattern.unit === 'GB' && pattern.monthly) {
        volumeTB = value / 1000;
      } else if (pattern.unit === 'M_records') {
        volumeTB = value * 1000000 * 0.000001;
      } else if (pattern.unit === 'B_records') {
        volumeTB = value * 1000000000 * 0.000001;
      }
      
      break;
    }
  }
  
  return Math.max(volumeTB, 0.1);
}

function estimateMonthlyCost(services, volumeTB) {
  const estimates = [];
  let totalLow = 0;
  let totalHigh = 0;
  
  for (const serviceKey of services) {
    const [provider, service] = serviceKey.split('.');
    const pricing = CLOUD_PRICING[provider]?.[service];
    
    if (!pricing) continue;
    
    let costLow = 0;
    let costHigh = 0;
    let details = [];
    
    if (serviceKey === 'aws.kinesis_data_streams') {
      costLow = 2 * pricing.shard_hour * 730;
      costHigh = 4 * pricing.shard_hour * 730;
      details.push(`${volumeTB > 1 ? '2-4' : '1-2'} shards`);
    } else if (serviceKey === 'aws.kinesis_firehose') {
      costLow = volumeTB * 1000 * pricing.data_ingestion;
      costHigh = costLow * 1.5;
      details.push(`${volumeTB.toFixed(1)}TB ingested`);
    } else if (serviceKey === 'aws.lambda') {
      const invocations = Math.min(volumeTB * 100, 10000);
      const duration = invocations * 1000 * pricing.duration * 0.5;
      costLow = (invocations / 1000000 * pricing.request) + duration;
      costHigh = costLow * 2;
      details.push(`${invocations.toFixed(0)}M invocations`);
    } else if (serviceKey === 'aws.s3') {
      costLow = volumeTB * 1000 * pricing.storage_standard;
      costHigh = volumeTB * 1000 * pricing.storage_ia;
      details.push(`${volumeTB.toFixed(1)}TB storage`);
    } else if (serviceKey === 'aws.glue') {
      costLow = 10 * 30 * pricing.job;
      costHigh = 20 * 30 * pricing.job;
      details.push('10-20 DPU-hours/day');
    } else if (serviceKey === 'aws.athena') {
      costLow = volumeTB * 10 * pricing.query / 1000;
      costHigh = volumeTB * 50 * pricing.query / 1000;
      details.push('10-50x data scanned');
    } else if (serviceKey === 'aws.redshift') {
      costLow = 2 * pricing.ra3_xlplus * 730;
      costHigh = 4 * pricing.ra3_xlplus * 730;
      details.push('2-4 ra3.xlplus nodes');
    } else if (serviceKey === 'gcp.bigquery') {
      const storage = volumeTB * 1000 * pricing.storage;
      const queries = volumeTB * 10 * pricing.query_on_demand / 1000;
      costLow = storage + queries;
      costHigh = storage * 2 + queries * 3;
      details.push('on-demand pricing');
    } else if (serviceKey === 'snowflake.compute') {
      const credits = 2 * 8 * 30;
      costLow = credits * pricing.standard;
      costHigh = credits * pricing.business_critical;
      details.push(`${credits} credits/month`);
    } else if (serviceKey === 'confluent.basic') {
      costLow = 2 * pricing.basic * 730;
      costHigh = 2 * pricing.standard * 730;
      details.push('2 CKUs');
    }
    
    if (costLow > 0) {
      estimates.push({
        service: serviceKey,
        serviceName: service.replace(/_/g, ' '),
        provider: provider.toUpperCase(),
        low: costLow,
        high: costHigh,
        details: details.join(', ')
      });
      
      totalLow += costLow;
      totalHigh += costHigh;
    }
  }
  
  return {
    services: estimates,
    total: { low: totalLow, high: totalHigh },
    assumptions: `Based on ${volumeTB.toFixed(1)}TB monthly volume`
  };
}

function formatCostEstimate(estimate) {
  if (estimate.services.length === 0) return null;
  
  const formatCurrency = (n) => {
    if (n >= 1000) return `$${(n/1000).toFixed(1)}k`;
    return `$${n.toFixed(0)}`;
  };
  
  let markdown = `### 💰 Estimated Cloud Cost (Monthly)\n\n`;
  markdown += `**Range: ${formatCurrency(estimate.total.low)} - ${formatCurrency(estimate.total.high)}/month**\n`;
  markdown += `*${estimate.assumptions}*\n\n`;
  markdown += `| Service | Est. Cost | Details |\n`;
  markdown += `|---------|-----------|----------|\n`;
  
  for (const svc of estimate.services) {
    const range = svc.low === svc.high 
      ? formatCurrency(svc.low)
      : `${formatCurrency(svc.low)}-${formatCurrency(svc.high)}`;
    markdown += `| ${svc.provider} ${svc.serviceName} | ${range} | ${svc.details} |\n`;
  }
  
  markdown += `\n> ⚠️ This is a rough estimate. Actual costs depend on data access patterns, optimization strategies, and reserved capacity.`;
  
  return markdown;
}

// ─── Prompt Generator ───
const BASE_PROMPT = `You are a senior technical interviewer assistant. Be CONCISE, DIRECT, and PRACTICAL.

Rules:
1. No greetings/fluff - straight to the answer
2. Start with core concept, expand only if needed
3. Always include practical examples (code or architecture)
4. Mention trade-offs and production considerations
5. Use markdown for readability
6. Answer in ENGLISH

IMPORTANT: After your technical answer, you MUST include a follow-up question suggestion. Format exactly as:
💡 **Follow-up:** [one insightful question the candidate could ask to show deeper understanding]`;

function generateJobPrompt(job) {
  if (!job) return BASE_PROMPT;
  
  const skills = JSON.parse(job.key_skills || '[]');
  const areas = JSON.parse(job.focus_areas || '[]');
  
  return `${BASE_PROMPT}

JOB CONTEXT:
- Role: ${job.name} at ${job.company || 'Unknown Company'}
- Seniority: ${job.seniority || 'senior'}
- Key Skills: ${skills.join(', ')}

FOCUS AREAS:
${areas.map(a => `- ${a}`).join('\n')}

JOB DESCRIPTION:
${job.description.slice(0, 800)}...

Tailor answers to emphasize relevant skills and provide examples from their stack.`;
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
    const withFollowUp = db.prepare("SELECT COUNT(*) as count FROM question_answers WHERE followUpQuestion IS NOT NULL").get();
    const withCostEstimate = db.prepare("SELECT COUNT(*) as count FROM question_answers WHERE cloudCostEstimate IS NOT NULL").get();
    
    res.json({
      sessions: sessions.count,
      questions: questions.count,
      totalCost: costs.total || 0,
      cachedQuestions: costs.cached || 0,
      jobProfiles: jobs.count,
      withFollowUp: withFollowUp.count,
      withCostEstimate: withCostEstimate.count,
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
      prompt: "Technical interview. Terms: SQL, Spark, Kafka, Airflow, Python, PySpark, dbt, Snowflake, BigQuery, data pipeline, ETL, streaming.",
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
      
      const followUpMatch = cached.answer.match(/💡 \*\*Follow-up:\*\* (.+?)(?:\n|$)/);
      const followUp = followUpMatch ? followUpMatch[1] : null;
      
      db.prepare(`
        INSERT INTO question_answers 
        (sessionId, question, answer, followUpQuestion, cloudCostEstimate, processingTimeMs, tokensInput, tokensOutput, cost, cached, tailored)
        VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 0)
      `).run(sessionId, question, cached.answer, followUp, cached.costEstimate || null).catch(() => {});
      
      return res.json({ 
        answer: cached.answer, 
        followUpQuestion: followUp,
        cloudCostEstimate: cached.costEstimate || null,
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

    // Ajusta parâmetros
    const isComplex = question.length > 100 || question.includes('design');
    const maxTokens = isComplex ? 2500 : 1500;
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

    let answer = completion.choices[0]?.message?.content || "";
    const processingTimeMs = Date.now() - startTime;
    const tokens = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const cost = estimateCost(tokens.prompt_tokens, tokens.completion_tokens);

    // Extrai follow-up
    let followUpQuestion = null;
    const followUpMatch = answer.match(/💡 \*\*Follow-up:\*\* (.+?)(?:\n|$)/);
    if (followUpMatch) {
      followUpQuestion = followUpMatch[1].trim();
    }

    // Gera estimativa de custo de nuvem
    let cloudCostEstimate = null;
    const mentionedServices = extractServicesFromText(answer + " " + question);
    if (mentionedServices.length > 0) {
      const volumeTB = extractDataVolume(answer + " " + question);
      const estimate = estimateMonthlyCost(mentionedServices, volumeTB);
      cloudCostEstimate = formatCostEstimate(estimate);
      
      if (cloudCostEstimate) {
        answer += "\n\n" + cloudCostEstimate;
      }
    }

    // Salva no cache
    responseCache.set(cacheKey, {
      answer,
      costEstimate: cloudCostEstimate,
      followUp: followUpQuestion
    });

    // Async DB write
    setTimeout(() => {
      db.prepare(`
        INSERT INTO question_answers 
        (sessionId, question, answer, followUpQuestion, cloudCostEstimate, processingTimeMs, tokensInput, tokensOutput, cost, cached, tailored)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, 
        question, 
        answer, 
        followUpQuestion, 
        cloudCostEstimate,
        processingTimeMs, 
        tokens.prompt_tokens, 
        tokens.completion_tokens, 
        cost, 
        0, 
        isTailored ? 1 : 0
      ).catch(e => console.warn("DB error:", e));
    }, 0);

    res.json({ 
      answer, 
      followUpQuestion,
      cloudCostEstimate,
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

${qa.followUpQuestion ? `**💡 Suggested Follow-up:** ${qa.followUpQuestion}` : ''}

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
║   ⚡ Interview Agent v2.1 - Enhanced           ║
╠════════════════════════════════════════════════╣
║   Features:                                      ║
║   • Job-specific tailored responses              ║
║   • Smart caching with LRU (200 items)           ║
║   • Follow-up question suggestions             ║
║   • Real-time cloud cost estimation            ║
║   • Cost tracking & export                       ║
╠════════════════════════════════════════════════╣
║   API: http://localhost:${PORT}                     ║
╚════════════════════════════════════════════════╝
  `);
});
