/**
 * server.js — Backend for LinkedIn Auto-Reply (Qwen)
 *
 * Provides POST /linkedin/draft endpoint that:
 *  1. Validates the request
 *  2. Optionally redacts PII (emails, phone numbers)
 *  3. Calls Alibaba DashScope Qwen API
 *  4. Returns the generated draft
 *
 * Environment variables:
 *  - DASHSCOPE_API_KEY (required)
 *  - ALIBABA_LLM_API_BASE_URL (optional, defaults to https://dashscope-intl.aliyuncs.com/compatible-mode/v1)
 *  - PORT (optional, default 3000)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

/* ============================================================
   Configuration
   ============================================================ */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const ALIBABA_LLM_API_BASE_URL =
  process.env.ALIBABA_LLM_API_BASE_URL ||
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

// Chat completions endpoint (OpenAI-compatible format)
const CHAT_COMPLETIONS_URL = `${ALIBABA_LLM_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

if (!DASHSCOPE_API_KEY) {
  console.error('❌ DASHSCOPE_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const app = express();

/* ============================================================
   Middleware
   ============================================================ */

// CORS — allow requests from the Chrome extension (content scripts)
app.use(
  cors({
    origin: [
      'https://www.linkedin.com',
      'chrome-extension://*',
    ],
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

// Also handle preflight for all routes
app.options('*', cors());

// JSON body parser (limit payload size)
app.use(express.json({ limit: '100kb' }));
  
/* ============================================================
   Rate Limiting (simple in-memory per IP per minute)
   ============================================================ */

const rateLimitMap = new Map(); // ip -> { count, resetTime }
const RATE_LIMIT_MAX = 15; // max requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Rate limit exceeded. Try again in ${retryAfter}s.`,
    });
  }

  next();
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

/* ============================================================
   PII Redaction
   ============================================================ */

/**
 * Redacts emails and phone numbers from text.
 * @param {string} text
 * @returns {string}
 */
function redactPII(text) {
  // Redact email addresses
  text = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[EMAIL REDACTED]'
  );

  // Redact phone numbers (various formats)
  text = text.replace(
    /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    '[PHONE REDACTED]'
  );

  return text;
}

/* ============================================================
   Request Validation
   ============================================================ */

const VALID_TONES = ['professional', 'friendly', 'concise'];
const VALID_ROLES = ['me', 'them'];
const VALID_STARTER_TEMPLATES = ['connected_with_you', 'self_introduction'];

/**
 * Validates the incoming request body.
 * @param {Object} body
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const {
    conversation,
    tone,
    recipientFirstName,
    senderFirstName,
    starterTemplate,
    senderHeadline,
  } = body;

  // conversation
  if (!Array.isArray(conversation)) {
    return { valid: false, error: '"conversation" must be an array.' };
  }

  if (conversation.length === 0 && !starterTemplate) {
    return { valid: false, error: '"conversation" must be non-empty unless "starterTemplate" is provided.' };
  }

  if (conversation.length > 50) {
    return { valid: false, error: '"conversation" exceeds max 50 messages.' };
  }

  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i];
    if (!msg || typeof msg !== 'object') {
      return { valid: false, error: `conversation[${i}] must be an object.` };
    }
    if (!VALID_ROLES.includes(msg.role)) {
      return { valid: false, error: `conversation[${i}].role must be "me" or "them".` };
    }
    if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
      return { valid: false, error: `conversation[${i}].text must be a non-empty string.` };
    }
  }

  // tone
  if (tone && !VALID_TONES.includes(tone)) {
    return { valid: false, error: `"tone" must be one of: ${VALID_TONES.join(', ')}` };
  }

  // recipientFirstName (optional)
  if (recipientFirstName !== undefined) {
    if (typeof recipientFirstName !== 'string') {
      return { valid: false, error: '"recipientFirstName" must be a string when provided.' };
    }
    if (recipientFirstName.length > 50) {
      return { valid: false, error: '"recipientFirstName" must be 50 characters or fewer.' };
    }
  }

  // senderFirstName (optional)
  if (senderFirstName !== undefined) {
    if (typeof senderFirstName !== 'string') {
      return { valid: false, error: '"senderFirstName" must be a string when provided.' };
    }
    if (senderFirstName.length > 50) {
      return { valid: false, error: '"senderFirstName" must be 50 characters or fewer.' };
    }
  }

  // senderHeadline (optional)
  if (senderHeadline !== undefined) {
    if (typeof senderHeadline !== 'string') {
      return { valid: false, error: '"senderHeadline" must be a string when provided.' };
    }
    if (senderHeadline.length > 200) {
      return { valid: false, error: '"senderHeadline" must be 200 characters or fewer.' };
    }
  }

  // starterTemplate (optional)
  if (starterTemplate !== undefined) {
    if (typeof starterTemplate !== 'string' || !VALID_STARTER_TEMPLATES.includes(starterTemplate)) {
      return {
        valid: false,
        error: `"starterTemplate" must be one of: ${VALID_STARTER_TEMPLATES.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

/* ============================================================
   Prompt Construction
   ============================================================ */

/**
 * Builds the system and user messages for Qwen.
 * @param {Array} conversation
 * @param {string} tone
 * @param {string} recipientFirstName
 * @param {string} senderFirstName
 * @param {string} starterTemplate
 * @param {string} senderHeadline
 * @returns {{ systemMsg: string, userMsg: string }}
 */
function buildPrompt(
  conversation,
  tone,
  recipientFirstName = '',
  senderFirstName = '',
  starterTemplate = '',
  senderHeadline = ''
) {
  const cleanedFirstName = (recipientFirstName || '').trim();
  const cleanedSenderName = (senderFirstName || '').trim();
  const cleanedSenderHeadline = (senderHeadline || '').trim();
  const systemMsg = [
    'You write natural LinkedIn replies that sound like a real person.',
    `Tone: ${tone || 'professional'}.`,
    'Keep it short (1-4 sentences).',
    'Write with clarity and warmth, not corporate filler.',
    'Avoid cliches: "Hope you are well", "touch base", "circle back", "kindly", "as per", "at your earliest convenience".',
    'Use contractions naturally when appropriate (I am, I would, we will).',
    'Be specific: reference one concrete detail from the last message when possible.',
    'Vary sentence openings; do not always start with greetings or thanks.',
    'No emojis unless the other person used emojis.',
    'If they ask for a meeting, propose two times.',
    'If unclear, ask one clarifying question.',
    'Do not mention you are AI. Do not add subject lines.',
    'Reply in the same language as the conversation.',
    'Do not use em dashes or —.',
    cleanedFirstName
      ? `Known recipient first name from profile: ${cleanedFirstName}. Use this naturally when needed, but prefer any name they introduce in chat.`
      : 'Use their name naturally only if known from the conversation.',
    'Never use placeholders like [Name]. If name is uncertain, do not include a name.',
  ].join(' ');

  if (starterTemplate) {
    const recipientDisplay = cleanedFirstName || 'there';
    const senderIntro = cleanedSenderName
      ? `I am ${cleanedSenderName}${cleanedSenderHeadline ? `, ${cleanedSenderHeadline}` : ''}`
      : (cleanedSenderHeadline ? `I am ${cleanedSenderHeadline}` : '');

    let templateInstruction = '';
    if (starterTemplate === 'connected_with_you') {
      templateInstruction =
        `Generate a first-contact message based on this intent: "Hi ${recipientDisplay}, thank you for connecting with me, how can I help you?"`;
    } else if (starterTemplate === 'self_introduction') {
      templateInstruction = senderIntro
        ? `Generate a first-contact message based on this intent: "Hi ${recipientDisplay}, ${senderIntro}, pleasure to meet you"`
        : `Generate a first-contact message based on this intent: "Hi ${recipientDisplay}, pleasure to meet you"`;
    }

    const userMsg = [
      'There is no prior chat history in this thread.',
      templateInstruction,
      'Keep it natural, concise, and ready to send on LinkedIn.',
    ].join('\n');

    return { systemMsg, userMsg };
  }

  const transcript = conversation
    .map((msg) => {
      const label = msg.role === 'me' ? 'Me' : 'Them';
      return `${label}: ${msg.text}`;
    })
    .join('\n');

  const userMsg = `Conversation:\n${transcript}\n\nWrite my next reply:`;

  return { systemMsg, userMsg };
}

function sanitizeDraftOutput(text) {
  if (!text || typeof text !== 'string') return '';
  // Hard-disable em/en/horizontal dashes in generated output.
  const withCapitalizedNextWord = text.replace(
    /[\u2012\u2013\u2014\u2015]\s*([A-Za-z])/g,
    (_match, nextChar) => `\n\n${nextChar.toUpperCase()}`
  );

  return withCapitalizedNextWord.replace(/[\u2012\u2013\u2014\u2015]\s*/g, '\n\n');
}

/* ============================================================
   DashScope Qwen API Call (OpenAI-compatible endpoint)
   ============================================================ */

/**
 * Calls the DashScope Qwen API via the OpenAI-compatible chat/completions endpoint.
 * URL: {ALIBABA_LLM_API_BASE_URL}/chat/completions
 *
 * @param {string} systemMsg
 * @param {string} userMsg
 * @param {string} model
 * @returns {Promise<string>}
 */
async function callQwen(systemMsg, userMsg, model = 'qwen-plus') {
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 300,
    temperature: 0.7,
    top_p: 0.9,
  };

  console.log(`🤖 Calling Qwen (model: ${model}) at ${CHAT_COMPLETIONS_URL}...`);

  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('DashScope API error:', response.status, errText);
    throw new Error(`DashScope API returned ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // OpenAI-compatible response structure:
  // { choices: [{ message: { role: "assistant", content: "..." } }] }
  const draft = data?.choices?.[0]?.message?.content || '';

  if (!draft) {
    console.error('Unexpected response structure:', JSON.stringify(data));
    throw new Error('No text content in DashScope response.');
  }

  console.log('✅ Draft generated successfully');
  return sanitizeDraftOutput(draft.trim());
}

/* ============================================================
   Routes
   ============================================================ */

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main endpoint: generate draft reply
app.post('/linkedin/draft', rateLimit, async (req, res) => {
  try {
    // 1. Validate
    const validation = validateRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    let {
      conversation,
      tone,
      model,
      redact,
      recipientFirstName,
      senderFirstName,
      starterTemplate,
      senderHeadline,
    } = req.body;
    tone = tone || 'professional';
    model = model || 'qwen-plus';

    // 2. Optionally redact PII
    if (redact) {
      conversation = conversation.map((msg) => ({
        ...msg,
        text: redactPII(msg.text),
      }));
      console.log('🔒 PII redaction applied');
    }

    // 3. Build prompt
    const { systemMsg, userMsg } = buildPrompt(
      conversation,
      tone,
      recipientFirstName,
      senderFirstName,
      starterTemplate,
      senderHeadline
    );

    // 4. Call Qwen
    const draft = await callQwen(systemMsg, userMsg, model);

    // 5. Return draft
    return res.json({ draft });
  } catch (err) {
    console.error('❌ Error generating draft:', err.message);
    return res.status(500).json({
      error: `Failed to generate draft: ${err.message}`,
    });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ============================================================
   Start Server
   ============================================================ */

app.listen(PORT, () => {
  console.log(`\n🚀 LinkedIn Auto-Reply server running on http://localhost:${PORT}`);
  console.log(`   POST /linkedin/draft — Generate a reply draft`);
  console.log(`   GET  /health         — Health check\n`);
});
