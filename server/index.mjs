// server/index.mjs
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cache semântico para respostas
const semanticCache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 60 * 24, // 24 horas
  updateAgeOnGet: true
});

// Database
const db = new Database('./data/interview-agent.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    transcription TEXT,
    answer TEXT,
    processing_time_ms INTEGER,
    cached BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Middleware
app.use(cors());
app.use(express.json());

// Multer config para áudio em memória
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Função para gerar chave semântica simples
function generateSemanticKey(text) {
  // Normaliza: lowercase, remove pontuação, palavras comuns
  const normalized = text
    .toLowerCase()
    .replace(/[.,?!;:'"]/g, '')
    .replace(/\b(o|a|os|as|um|uma|de|da|do|em|no|na|que|e|ou|para|por)\b/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
  
  return createHash('md5').update(normalized).digest('hex');
}

// Endpoint: Transcrição rápida
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file' });
    }

    // Whisper com configurações otimizadas
    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], req.file.originalname, { type: req.file.mimetype }),
      model: 'whisper-1',
      language: process.env.DEFAULT_LANGUAGE || 'pt',
      response_format: 'text',
      prompt: 'Entrevista técnica de Data Engineering, SQL, Python, Spark, AWS, GCP',
      temperature: 0 // Mais determinístico
    });

    const processingTime = Date.now() - startTime;

    res.json({
      transcription: transcription.trim(),
      processingTime,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Streaming de resposta (Server-Sent Events)
app.post('/api/answer-stream', async (req, res) => {
  const { transcription, sessionId, maxTokens = 400, temperature = 0.3 } = req.body;
  const startTime = Date.now();

  try {
    // Verifica cache primeiro
    const cacheKey = generateSemanticKey(transcription);
    const cached = semanticCache.get(cacheKey);
    
    if (cached) {
      // Retorna do cache via stream simulado
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Simula streaming do cache para UX consistente
      const words = cached.split(' ');
      for (let i = 0; i < words.length; i += 3) {
        const chunk = words.slice(i, i + 3).join(' ') + ' ';
        res.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
        await new Promise(r => setTimeout(r, 20)); // Delay artificial suave
      }
      
      res.write(`data: ${JSON.stringify({ 
        type: 'done', 
        fullAnswer: cached,
        usage: { cached: true }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      
      // Salva no DB marcado como cache
      db.prepare(`
        INSERT INTO interactions (session_id, transcription, answer, processing_time_ms, cached)
        VALUES (?, ?, ?, ?, 1)
      `).run(sessionId, transcription, cached, Date.now() - startTime);
      
      return;
    }

    // Configura SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream do GPT
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Você é um especialista sênior em Data Engineering.
Responda de forma técnica, concisa e direta.
Estruture com: 1) Conceito chave, 2) Exemplo prático ou código, 3) Melhor prática.
Máximo 3 parágrafos. Use markdown para código.`
        },
        { role: 'user', content: transcription }
      ],
      max_tokens: maxTokens,
      temperature: temperature,
      stream: true
    });

    let fullAnswer = '';
    let tokenCount = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnswer += content;
        tokenCount++;
        
        res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        
        // Flush a cada chunk para entrega imediata
        if (res.flush) res.flush();
      }
    }

    // Finaliza stream
    res.write(`data: ${JSON.stringify({ 
      type: 'done', 
      fullAnswer,
      usage: { completion_tokens: tokenCount }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

    // Salva no cache e DB
    semanticCache.set(cacheKey, fullAnswer);
    
    db.prepare(`
      INSERT INTO interactions (session_id, transcription, answer, processing_time_ms, cached)
      VALUES (?, ?, ?, ?, 0)
    `).run(sessionId, transcription, fullAnswer, Date.now() - startTime);

  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

// Endpoint: Histórico
app.get('/api/history/:sessionId', (req, res) => {
  const interactions = db.prepare(`
    SELECT * FROM interactions 
    WHERE session_id = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).all(req.params.sessionId);
  
  res.json(interactions);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    cacheSize: semanticCache.size,
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Cache size: ${semanticCache.max} items`);
});
