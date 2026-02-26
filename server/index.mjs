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

// Cache com consideração de contexto
const responseCache = new LRUCache({
  max: 300,
  ttl: 1000 * 60 * 60 * 6, // 6 horas
});

const db = new Database('./data/interview-agent.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    transcription TEXT,
    answer TEXT,
    context_length INTEGER,
    processing_time_ms INTEGER,
    tokens_input INTEGER,
    tokens_output INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Gera chave de cache considerando contexto recente
function generateCacheKey(transcription, context) {
  // Normaliza pergunta atual
  const normalized = transcription
    .toLowerCase()
    .replace(/[.,?!;:'"\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Inclui hash das 2 últimas interações no contexto
  const contextHash = context.length > 0 
    ? createHash('md5')
        .update(context.slice(-2).map(c => c.content).join('|'))
        .digest('hex')
        .slice(0, 8)
    : 'noctx';
  
  const key = createHash('md5')
    .update(`${normalized}:${contextHash}`)
    .digest('hex');
    
  return key;
}

// Endpoint: Transcrição
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const start = Date.now();
  
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], 'speech.webm', { type: req.file.mimetype }),
      model: 'whisper-1',
      language: process.env.DEFAULT_LANGUAGE || 'pt',
      response_format: 'text',
      prompt: 'Entrevista técnica de Data Engineering: SQL, Python, Spark, Airflow, AWS, GCP, BigQuery',
    });

    res.json({
      transcription: transcription.trim(),
      processingTime: Date.now() - start
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint: Resposta com Contexto (Streaming)
app.post('/api/answer-context', async (req, res) => {
  const { transcription, context, sessionId } = req.body;
  const startTime = Date.now();
  
  try {
    // Verifica cache (agora considera contexto)
    const cacheKey = generateCacheKey(transcription, context);
    const cached = responseCache.get(cacheKey);
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (cached) {
      // Retorna do cache com delay natural
      const words = cached.split(' ');
      for (let i = 0; i < words.length; i += 2) {
        const chunk = words.slice(i, i + 2).join(' ') + ' ';
        res.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
        await new Promise(r => setTimeout(r, 15));
      }
      
      res.write(`data: ${JSON.stringify({ type: 'done', cached: true })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Monta mensagens com contexto
    const messages = [
      {
        role: 'system',
        content: `Você é um especialista sênior em Data Engineering durante uma entrevista técnica.
REGRAS:
- Respostas técnicas, diretas e concisas (máx 3 parágrafos)
- Inclua exemplos de código quando relevante
- Se a pergunta for follow-up de uma anterior, mantenha coerência com o contexto
- Use markdown para formatação`
      }
    ];

    // Adiciona contexto recente (até 4 mensagens anteriores)
    if (context && context.length > 0) {
      messages.push(...context.slice(-4));
    }

    // Adiciona pergunta atual
    messages.push({ role: 'user', content: transcription });

    // Stream da resposta
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 500,
      temperature: 0.4, // Ligeiramente mais criativo para contextualização
      stream: true
    });

    let fullAnswer = '';
    let tokens = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnswer += content;
        tokens++;
        
        res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        if (res.flush) res.flush();
      }
    }

    // Salva no cache e DB
    responseCache.set(cacheKey, fullAnswer);
    
    db.prepare(`
      INSERT INTO interactions 
      (session_id, transcription, answer, context_length, processing_time_ms, tokens_output)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      transcription,
      fullAnswer,
      context.length,
      Date.now() - startTime,
      tokens
    );

    res.write(`data: ${JSON.stringify({ type: 'done', usage: { completion_tokens: tokens } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT} | Cache: ${responseCache.max} items`);
});
