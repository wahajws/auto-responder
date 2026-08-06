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
  import fs from 'fs/promises';
  import path from 'path';
  import { fileURLToPath } from 'url';
  import { google } from 'googleapis';

  /* ============================================================
    Configuration 
    ============================================================ */

  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const ALIBABA_LLM_API_BASE_URL =
  process.env.ALIBABA_LLM_API_BASE_URL ||
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';
const APOLLO_API_BASE_URL =
  process.env.APOLLO_API_BASE_URL ||
  'https://api.apollo.io/api/v1';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/google/auth/callback`;

  // Chat completions endpoint (OpenAI-compatible format)
  const CHAT_COMPLETIONS_URL = `${ALIBABA_LLM_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const DATA_DIR = path.join(__dirname, 'data');
  const GOOGLE_TOKEN_FILE = path.join(DATA_DIR, 'google_tokens.json');
  const DEFAULT_EVENT_TITLE = 'LinkedIn Meeting';

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
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (origin === 'https://www.linkedin.com') return callback(null, true);
        if (origin.startsWith('chrome-extension://')) return callback(null, true);
        return callback(new Error(`Origin not allowed: ${origin}`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
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
    Google Calendar Integration
    ============================================================ */

  function isGoogleConfigured() {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
  }

  function getGoogleOAuthClient() {
    return new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
  }

  async function ensureDataDir() {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }

  async function readGoogleTokens() {
    try {
      const raw = await fs.readFile(GOOGLE_TOKEN_FILE, 'utf8');
      return JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }

  async function writeGoogleTokens(tokens) {
    await ensureDataDir();
    await fs.writeFile(GOOGLE_TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  }

  async function clearGoogleTokens() {
    try {
      await fs.unlink(GOOGLE_TOKEN_FILE);
    } catch (_err) {
      // Ignore missing file.
    }
  }

  async function getAuthorizedGoogleClients() {
    if (!isGoogleConfigured()) {
      throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.');
    }

    const tokens = await readGoogleTokens();
    if (!tokens) {
      throw new Error('Google account not connected.');
    }

    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials(tokens);

    if (typeof oauth2Client.refreshAccessToken === 'function') {
      try {
        const refreshed = await oauth2Client.refreshAccessToken();
        if (refreshed?.credentials) {
          oauth2Client.setCredentials({
            ...tokens,
            ...refreshed.credentials,
            refresh_token: refreshed.credentials.refresh_token || tokens.refresh_token,
          });
          await writeGoogleTokens(oauth2Client.credentials);
        }
      } catch (_err) {
        // If refresh fails, continue and let API call surface auth errors.
      }
    }

    return {
      oauth2Client,
      calendar: google.calendar({ version: 'v3', auth: oauth2Client }),
    };
  }

  function formatSlotLabel(startIso, endIso, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    });
    return `${formatter.format(new Date(startIso))} - ${formatter.format(new Date(endIso))}`;
  }

  function rangesOverlap(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
  }

  function generateCandidateSlots({
    lookaheadDays,
    workStartHour,
    workEndHour,
    durationMinutes,
  }) {
    const slots = [];
    const now = new Date();
    now.setSeconds(0, 0);

    for (let dayOffset = 0; dayOffset < lookaheadDays; dayOffset++) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() + dayOffset);
      dayStart.setHours(workStartHour, 0, 0, 0);

      const day = dayStart.getDay();
      const isWeekend = day === 0 || day === 6;
      if (isWeekend) continue;

      for (let hour = workStartHour; hour < workEndHour; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          const start = new Date(dayStart);
          start.setHours(hour, minute, 0, 0);
          const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
          if (start <= now) continue;
          if (end.getHours() > workEndHour || (end.getHours() === workEndHour && end.getMinutes() > 0)) continue;
          slots.push({ start: start.toISOString(), end: end.toISOString() });
        }
      }
    }
    return slots;
  }

  async function getFreeSlots({
    timeZone,
    lookaheadDays = 14,
    workStartHour = 9,
    workEndHour = 18,
    durationMinutes = 30,
    limit = 2,
  }) {
    const { calendar } = await getAuthorizedGoogleClients();
    const startWindow = new Date();
    const endWindow = new Date();
    endWindow.setDate(startWindow.getDate() + lookaheadDays);

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: startWindow.toISOString(),
        timeMax: endWindow.toISOString(),
        timeZone,
        items: [{ id: 'primary' }],
      },
    });

    const busy = fb?.data?.calendars?.primary?.busy || [];
    const candidates = generateCandidateSlots({
      lookaheadDays,
      workStartHour,
      workEndHour,
      durationMinutes,
    });

    const free = [];
    for (const slot of candidates) {
      const slotStart = new Date(slot.start);
      const slotEnd = new Date(slot.end);
      const overlaps = busy.some((b) => rangesOverlap(
        slotStart,
        slotEnd,
        new Date(b.start),
        new Date(b.end)
      ));
      if (!overlaps) {
        free.push({
          start: slot.start,
          end: slot.end,
          label: formatSlotLabel(slot.start, slot.end, timeZone),
        });
        if (free.length >= limit) break;
      }
    }

    return free;
  }

  async function createCalendarEvent({
    startIso,
    endIso,
    timeZone,
    title = DEFAULT_EVENT_TITLE,
    description = '',
  }) {
    const { calendar } = await getAuthorizedGoogleClients();
    const insertRes = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: title,
        description,
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone },
        conferenceData: {
          createRequest: {
            requestId: `linkedin-autoreply-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });

    return {
      id: insertRes?.data?.id || '',
      htmlLink: insertRes?.data?.htmlLink || '',
      meetLink: insertRes?.data?.hangoutLink || '',
      start: insertRes?.data?.start?.dateTime || startIso,
      end: insertRes?.data?.end?.dateTime || endIso,
    };
  }

  function isLikelyMeetingRequest(text) {
    return /\b(meeting|call|sync|availability|available|when can|when are you free|let'?s meet|schedule)\b/i.test(text);
  }

  function isExplicitAcceptance(text) {
    return /\b(that works|works for me|sounds good|perfect|confirmed|let'?s do it|see you then|okay that works|ok that works)\b/i.test(text);
  }

  function isCounterProposal(text) {
    return /\b(won'?t work|doesn'?t work|not available|how about|instead|tomorrow|next week|at\s*\d{1,2}(:\d{2})?\s*(am|pm))\b/i.test(text);
  }

  function decideSchedulingAction({ conversation, threadState }) {
    const safeState = threadState && typeof threadState === 'object' ? threadState : {};
    const turnCount = Number(safeState.turnCount || 0);
    if (turnCount >= 6) {
      return {
        action: 'manual_handoff',
        reason: 'turn_limit_reached',
      };
    }

    const lastThem = [...conversation].reverse().find((m) => m?.role === 'them' && typeof m?.text === 'string');
    if (!lastThem) return { action: 'no_action', reason: 'no_incoming_message' };

    const text = lastThem.text.trim();
    if (isExplicitAcceptance(text) && Array.isArray(safeState.proposedSlots) && safeState.proposedSlots.length > 0) {
      const chosen = safeState.selectedSlot || safeState.proposedSlots[0];
      return {
        action: 'confirm_create_event',
        selectedSlot: chosen,
        reason: 'explicit_acceptance',
      };
    }

    if (isCounterProposal(text)) {
      return {
        action: 'counter_propose',
        reason: 'counter_proposal_detected',
        requestedText: text,
      };
    }

    if (isLikelyMeetingRequest(text)) {
      return {
        action: 'propose_slots',
        reason: 'meeting_request_detected',
      };
    }

    return { action: 'no_action', reason: 'no_schedule_intent' };
  }

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
    const latestMessage = Array.isArray(conversation) && conversation.length
      ? conversation[conversation.length - 1]
      : null;
    const latestReceiverMessage = Array.isArray(conversation)
      ? [...conversation].reverse().find((msg) => msg?.role === 'them' && typeof msg?.text === 'string')
      : null;
    const systemMsg = [
      'You write natural LinkedIn replies that sound like a real person.',
      `Tone: ${tone || 'professional'}.`,
      'Keep it short (1-4 sentences).',
      'Write like a real professional on LinkedIn: natural, specific, and concise.',
      'Avoid corporate filler and stiff phrasing.',
      'Avoid cliches: "Hope you are well", "touch base", "circle back", "kindly", "as per", "at your earliest convenience".',
      'When possible, reference one concrete detail from the latest message from Them.',
      'Do not over-explain, repeat, or sound overly polished.',
      'Vary sentence openings naturally.',
      'No emojis unless the other person used emojis.',
      'If they ask for a meeting and no specific time has been confirmed yet, propose up to two times.',
      'If unclear, ask one clarifying question.',
      'Do not mention you are AI. Do not add subject lines.',
      'Reply in the same language as the conversation.',
      'Do not use em dashes or —.',
      'Do not sound salesy, overly enthusiastic, or like a template.',
      'Preserve the user’s likely intent and do not introduce new claims, promises, or facts.',
      cleanedFirstName
        ? `Known recipient first name from profile: ${cleanedFirstName}. Use this naturally when needed, but prefer any name they introduce in chat.`
        : 'Use their name naturally only if known from the conversation.',
      'Priority rule: the main message to respond to is the latest message from Them (receiver).',
      'If the latest overall message is from Me, still anchor the reply to the latest message from Them.',
      'Older turns are background context only; do not let older context override the latest receiver intent.',
      'Never use placeholders of any kind (for example: [Name], <name>, {{name}}, (company), or TBD).',
      'Do not output bracketed tokens or template markers in any sentence.',
      'If any detail is uncertain, do not guess and do not leave a placeholder; simplify the sentence or omit that part entirely.',
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

    const latestReceiverLine = latestReceiverMessage
      ? `Latest message from Them (PRIMARY): ${latestReceiverMessage.text}`
      : 'Latest message from Them (PRIMARY): none found';
    const latestOverallLine = latestMessage
      ? `Latest overall message: ${latestMessage.role === 'me' ? 'Me' : 'Them'}: ${latestMessage.text}`
      : 'Latest overall message: none found';

    const userMsg = `${latestReceiverLine}\n${latestOverallLine}\n\nConversation:\n${transcript}\n\nWrite my next reply to the latest receiver message:`;

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

  function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      throw new Error('Empty model response.');
    }

    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch ? fencedMatch[1].trim() : raw;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Model response did not contain a JSON object.');
    }

    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }

async function buildPeopleSearchPlan(prompt, model = 'qwen-plus') {
  const systemMsg = [
    'You turn a natural-language recruiting request into a LinkedIn people search plan.',
    'Return JSON only.',
    'Schema:',
    '{',
    '  "searchKeywords": string,',
    '  "minConnections": number,',
    '  "locationIncludes": string[],',
    '  "headlineIncludes": string[],',
    '  "headlineExcludes": string[],',
    '  "personTitles": string[],',
    '  "personLocations": string[],',
    '  "includeKeywords": string[],',
    '  "excludeKeywords": string[],',
    '  "page": number,',
    '  "perPage": number',
    '}',
    'Rules:',
    '- searchKeywords is the only part used in the LinkedIn search URL.',
    '- personTitles and personLocations should be suitable Apollo search filters.',
    '- locationIncludes, headlineIncludes, headlineExcludes, includeKeywords, excludeKeywords, and minConnections are post-search cleanup filters.',
    '- searchKeywords must be short, high-signal, and suitable for LinkedIn people search.',
    '- Keep searchKeywords to plain words only, no punctuation except spaces.',
    '- Include role and geography if the user asked for them.',
    '- If the user asks for lots of connections, set minConnections to 100.',
    '- If the user gives an explicit number of connections, use that number.',
    '- If the user does not mention connections, default minConnections to 100.',
    '- locationIncludes should contain short place strings only when useful for local filtering.',
    '- headlineIncludes should contain must-have role or domain terms that help remove unwanted results.',
    '- headlineExcludes should contain unwanted role/domain terms when the user implies exclusions.',
    '- personTitles should contain concrete title phrases only.',
    '- personLocations should contain broad place strings only.',
    '- includeKeywords and excludeKeywords should be short text fragments for local filtering.',
    '- Default page to 1 and perPage to 10 unless the user explicitly asks otherwise.',
    '- Use empty arrays when a filter is not needed.',
    '- Do not include explanations or markdown.',
  ].join('\n');

    const userMsg = `User request: ${prompt}`;
    const rawPlan = await callQwen(systemMsg, userMsg, model);
    const parsed = extractJsonObject(rawPlan);

  return {
    searchKeywords: String(parsed?.searchKeywords || '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    minConnections: Math.max(0, parseInt(parsed?.minConnections, 10) || 100),
    locationIncludes: Array.isArray(parsed?.locationIncludes)
      ? parsed.locationIncludes
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    headlineIncludes: Array.isArray(parsed?.headlineIncludes)
      ? parsed.headlineIncludes
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    headlineExcludes: Array.isArray(parsed?.headlineExcludes)
      ? parsed.headlineExcludes
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    personTitles: Array.isArray(parsed?.personTitles)
      ? parsed.personTitles
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    personLocations: Array.isArray(parsed?.personLocations)
      ? parsed.personLocations
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    includeKeywords: Array.isArray(parsed?.includeKeywords)
      ? parsed.includeKeywords
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    excludeKeywords: Array.isArray(parsed?.excludeKeywords)
      ? parsed.excludeKeywords
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    page: Math.max(1, parseInt(parsed?.page, 10) || 1),
    perPage: Math.min(100, Math.max(1, parseInt(parsed?.perPage, 10) || 10)),
  };
}

/* ============================================================
   Routes
   ============================================================ */

function isApolloConfigured() {
  return !!APOLLO_API_KEY;
}

function assertApolloConfigured() {
  if (!isApolloConfigured()) {
    const err = new Error('APOLLO_API_KEY is not configured on the server.');
    err.statusCode = 503;
    throw err;
  }
}

function appendApolloQuery(searchParams, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .forEach((item) => searchParams.append(`${key}[]`, item));
    return;
  }
  searchParams.set(key, String(value));
}

function extractApolloRateLimit(headers) {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (!limit && !remaining && !reset) return null;
  return {
    limit: limit ? Number(limit) : null,
    remaining: remaining ? Number(remaining) : null,
    reset: reset || null,
  };
}

async function callApollo(pathname, { method = 'POST', query = {}, body } = {}) {
  assertApolloConfigured();
  const url = new URL(`${APOLLO_API_BASE_URL.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`);
  Object.entries(query || {}).forEach(([key, value]) => appendApolloQuery(url.searchParams, key, value));

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${APOLLO_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error || data?.message || rawText || `Apollo API returned ${response.status}`;
    const err = new Error(message);
    err.statusCode = response.status;
    throw err;
  }

  return {
    data,
    rateLimit: extractApolloRateLimit(response.headers),
  };
}

function cleanStringArray(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function splitFullName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  };
}

function extractDomainFromWebsiteUrl(websiteUrl) {
  const raw = String(websiteUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./i, '');
  } catch (_err) {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}

function buildApolloSearchFilters(plan = {}, page = 1, perPage = 10) {
  return {
    page: Math.max(1, parseInt(page || plan.page, 10) || 1),
    per_page: Math.min(100, Math.max(1, parseInt(perPage || plan.perPage, 10) || 10)),
    person_titles: cleanStringArray(plan.personTitles),
    person_locations: cleanStringArray(plan.personLocations),
  };
}

function normalizeApolloPersonRecord(record) {
  const person = record?.person || record || {};
  const organization = person.organization || person.account || {};
  const firstName = String(person.first_name || '').trim();
  const lastName = String(person.last_name || '').trim();
  const fallbackName = String(person.name || [firstName, lastName].filter(Boolean).join(' ')).trim();
  const companyDomain = String(
    organization.primary_domain ||
    organization.domain ||
    organization.website_url ||
    person.organization_website_url ||
    ''
  ).trim();
  const location = [
    person.city,
    person.state,
    person.country,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(', ');

  return {
    name: fallbackName,
    firstName,
    lastName,
    title: String(person.title || '').trim(),
    company: String(
      organization.name ||
      person.organization_name ||
      person.account_name ||
      ''
    ).trim(),
    companyDomain: extractDomainFromWebsiteUrl(companyDomain),
    linkedinUrl: String(person.linkedin_url || '').trim(),
    location,
    emails: cleanStringArray(person.email ? [person.email] : []),
    phones: [],
    apolloPersonId: String(person.id || person.person_id || '').trim(),
    source: 'apollo',
  };
}

function buildApolloSearchLocalText(result) {
  return [
    result.name,
    result.title,
    result.company,
    result.location,
  ].filter(Boolean).join(' ').toLowerCase();
}

function applyApolloPlanPostFilters(results, plan = {}) {
  const includeKeywords = cleanStringArray(plan.includeKeywords).map((value) => value.toLowerCase());
  const excludeKeywords = cleanStringArray(plan.excludeKeywords).map((value) => value.toLowerCase());
  const headlineIncludes = cleanStringArray(plan.headlineIncludes).map((value) => value.toLowerCase());
  const headlineExcludes = cleanStringArray(plan.headlineExcludes).map((value) => value.toLowerCase());
  const locationIncludes = cleanStringArray(plan.locationIncludes).map((value) => value.toLowerCase());

  return results.filter((result) => {
    const fullText = buildApolloSearchLocalText(result);
    const titleText = String(result.title || '').toLowerCase();
    const locationText = String(result.location || '').toLowerCase();

    if (includeKeywords.length > 0 && !includeKeywords.every((term) => fullText.includes(term))) {
      return false;
    }
    if (excludeKeywords.some((term) => fullText.includes(term))) {
      return false;
    }
    if (headlineIncludes.length > 0 && !headlineIncludes.every((term) => titleText.includes(term))) {
      return false;
    }
    if (headlineExcludes.some((term) => titleText.includes(term))) {
      return false;
    }
    if (locationIncludes.length > 0 && !locationIncludes.some((term) => locationText.includes(term))) {
      return false;
    }
    return true;
  });
}

function buildApolloEnrichmentInput(person) {
  const normalizedName = String(person?.name || '').trim();
  const splitName = splitFullName(normalizedName);
  const firstName = String(person?.first_name || person?.firstName || splitName.firstName || '').trim();
  const lastName = String(person?.last_name || person?.lastName || splitName.lastName || '').trim();
  const email = String(person?.email || '').trim();
  const domain = extractDomainFromWebsiteUrl(person?.website_url || person?.companyDomain || '');

  return {
    email,
    first_name: firstName,
    last_name: lastName,
    name: normalizedName || [firstName, lastName].filter(Boolean).join(' ').trim(),
    domain,
    raw: person,
  };
}

function buildApolloSingleMatchQuery(person, revealPersonalEmails, revealPhoneNumber) {
  const matchInput = buildApolloEnrichmentInput(person);
  const query = {
    reveal_personal_emails: revealPersonalEmails ? 'true' : 'false',
    reveal_phone_number: revealPhoneNumber ? 'true' : 'false',
  };

  if (matchInput.email) query.email = matchInput.email;
  if (matchInput.first_name) query.first_name = matchInput.first_name;
  if (matchInput.last_name) query.last_name = matchInput.last_name;
  if (matchInput.name) query.name = matchInput.name;
  if (matchInput.domain) query.domain = matchInput.domain;

  return query;
}

function buildApolloBulkMatchBody(people, revealPersonalEmails, revealPhoneNumber) {
  return {
    details: people.map((person) => {
      const matchInput = buildApolloEnrichmentInput(person);
      const detail = {};
      if (matchInput.email) detail.email = matchInput.email;
      if (matchInput.first_name) detail.first_name = matchInput.first_name;
      if (matchInput.last_name) detail.last_name = matchInput.last_name;
      if (matchInput.name) detail.name = matchInput.name;
      if (matchInput.domain) detail.domain = matchInput.domain;
      return detail;
    }),
    reveal_personal_emails: !!revealPersonalEmails,
    reveal_phone_number: !!revealPhoneNumber,
  };
}

function getApolloBulkMatchRecords(data) {
  if (Array.isArray(data?.matches)) return data.matches;
  if (Array.isArray(data?.people)) return data.people;
  if (Array.isArray(data?.persons)) return data.persons;
  if (Array.isArray(data?.details)) return data.details;
  return [];
}

function normalizeApolloEnrichmentRecord(record, fallback = {}) {
  const person = record?.person || record?.match || record || {};
  const base = normalizeApolloPersonRecord(person);
  const fallbackName = String(fallback.name || '').trim();
  const fallbackFirstName = String(fallback.first_name || fallback.firstName || '').trim();
  const fallbackLastName = String(fallback.last_name || fallback.lastName || '').trim();
  const fallbackCompany = String(fallback.organization_name || fallback.company || '').trim();
  const fallbackDomain = extractDomainFromWebsiteUrl(fallback.website_url || fallback.companyDomain || '');
  const fallbackLinkedin = String(fallback.linkedin_url || fallback.linkedinUrl || '').trim();

  const emails = cleanStringArray([
    ...(Array.isArray(person.email_addresses) ? person.email_addresses.map((entry) => entry?.email || entry?.value || '') : []),
    person.email,
    record?.email,
  ]);

  const phones = cleanStringArray([
    ...(Array.isArray(person.phone_numbers) ? person.phone_numbers.map((entry) => entry?.raw_number || entry?.sanitized_number || entry?.number || '') : []),
    record?.phone,
  ]);

  return {
    name: base.name || fallbackName,
    firstName: base.firstName || fallbackFirstName,
    lastName: base.lastName || fallbackLastName,
    title: base.title || String(record?.title || '').trim(),
    company: base.company || fallbackCompany,
    companyDomain: base.companyDomain || fallbackDomain,
    linkedinUrl: base.linkedinUrl || fallbackLinkedin,
    location: base.location,
    emails,
    phones,
    apolloPersonId: base.apolloPersonId,
    source: 'apollo',
  };
}

async function searchApolloPeople(plan, page, perPage) {
  const filters = buildApolloSearchFilters(plan, page, perPage);
  const { data, rateLimit } = await callApollo('mixed_people/api_search', {
    method: 'POST',
    query: filters,
    body: {},
  });

  const rawPeople = Array.isArray(data?.people)
    ? data.people
    : Array.isArray(data?.persons)
      ? data.persons
      : [];

  const normalized = rawPeople.map((person) => normalizeApolloPersonRecord(person));
  const filtered = applyApolloPlanPostFilters(normalized, plan);
  const total = Number.isFinite(Number(data?.pagination?.total_entries))
    ? Number(data.pagination.total_entries)
    : Number.isFinite(Number(data?.total_entries))
      ? Number(data.total_entries)
      : null;
  const currentPage = filters.page;
  const currentPerPage = filters.per_page;
  const hasMore = total === null
    ? rawPeople.length === currentPerPage
    : currentPage * currentPerPage < total;

  return {
    results: filtered,
    pagination: {
      page: currentPage,
      perPage: currentPerPage,
      hasMore,
      total,
    },
    meta: {
      rateLimit,
      plan,
      unsupportedFilters: plan.minConnections ? ['minConnections'] : [],
    },
  };
}

async function enrichApolloPeople(people, revealPersonalEmails = false, revealPhoneNumber = false) {
  const inputPeople = Array.isArray(people) ? people : [];
  const results = new Array(inputPeople.length).fill(null);

  for (let i = 0; i < inputPeople.length; i += 10) {
    const chunk = inputPeople.slice(i, i + 10);
    if (chunk.length === 1) {
      const { data } = await callApollo('people/match', {
        method: 'POST',
        query: buildApolloSingleMatchQuery(chunk[0], revealPersonalEmails, revealPhoneNumber),
      });
      results[i] = normalizeApolloEnrichmentRecord(data?.person || data, chunk[0]);
      continue;
    }

    const { data } = await callApollo('people/bulk_match', {
      method: 'POST',
      body: buildApolloBulkMatchBody(chunk, revealPersonalEmails, revealPhoneNumber),
    });
    const records = getApolloBulkMatchRecords(data);
    chunk.forEach((person, chunkIndex) => {
      results[i + chunkIndex] = normalizeApolloEnrichmentRecord(records[chunkIndex] || {}, person);
    });
  }

  return results.map((result, index) => result || normalizeApolloEnrichmentRecord({}, inputPeople[index]));
}

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/google/auth/start', (_req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(500).send('Google OAuth is not configured on server.');
    }

    const oauth2Client = getGoogleOAuthClient();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar',
      ],
    });

    return res.redirect(authUrl);
  });

  app.get('/google/auth/callback', async (req, res) => {
    try {
      if (!isGoogleConfigured()) {
        return res.status(500).send('Google OAuth is not configured on server.');
      }

      const code = req.query?.code;
      if (!code || typeof code !== 'string') {
        return res.status(400).send('Missing OAuth code.');
      }

      const oauth2Client = getGoogleOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);
      await writeGoogleTokens(tokens);

      return res.status(200).send(
        '<html><body><h3>Google Calendar connected.</h3><p>You can close this tab and return to the extension popup.</p></body></html>'
      );
    } catch (err) {
      return res.status(500).send(`Failed to complete OAuth callback: ${err.message}`);
    }
  });

  app.get('/google/auth/status', async (_req, res) => {
    try {
      if (!isGoogleConfigured()) {
        return res.json({ connected: false, configured: false });
      }
      const tokens = await readGoogleTokens();
      return res.json({
        connected: !!tokens,
        configured: true,
        hasRefreshToken: !!tokens?.refresh_token,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/google/auth/disconnect', async (_req, res) => {
    try {
      await clearGoogleTokens();
      return res.json({ disconnected: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/calendar/availability', rateLimit, async (req, res) => {
    try {
      const {
        timeZone = 'UTC',
        lookaheadDays = 14,
        workStartHour = 9,
        workEndHour = 18,
        durationMinutes = 30,
        limit = 2,
      } = req.body || {};

      const slots = await getFreeSlots({
        timeZone,
        lookaheadDays: Math.min(Math.max(Number(lookaheadDays) || 14, 1), 30),
        workStartHour: Math.min(Math.max(Number(workStartHour) || 9, 0), 23),
        workEndHour: Math.min(Math.max(Number(workEndHour) || 18, 1), 24),
        durationMinutes: Math.min(Math.max(Number(durationMinutes) || 30, 15), 180),
        limit: Math.min(Math.max(Number(limit) || 2, 1), 5),
      });

      return res.json({ slots });
    } catch (err) {
      return res.status(500).json({ error: `Failed to fetch availability: ${err.message}` });
    }
  });

  app.post('/calendar/events', rateLimit, async (req, res) => {
    try {
      const {
        startIso,
        endIso,
        timeZone = 'UTC',
        title = DEFAULT_EVENT_TITLE,
        description = '',
      } = req.body || {};

      if (!startIso || !endIso) {
        return res.status(400).json({ error: 'startIso and endIso are required.' });
      }

      const event = await createCalendarEvent({
        startIso,
        endIso,
        timeZone,
        title,
        description,
      });

      return res.json({ event });
    } catch (err) {
      return res.status(500).json({ error: `Failed to create event: ${err.message}` });
    }
  });

  app.post('/linkedin/schedule/decide', rateLimit, async (req, res) => {
    try {
      const { conversation, threadState = {} } = req.body || {};
      if (!Array.isArray(conversation)) {
        return res.status(400).json({ error: '"conversation" must be an array.' });
      }
      const decision = decideSchedulingAction({ conversation, threadState });
      return res.json(decision);
    } catch (err) {
      return res.status(500).json({ error: `Failed to decide scheduling action: ${err.message}` });
    }
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

app.post('/linkedin/people-search/plan', rateLimit, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const model = String(req.body?.model || 'qwen-plus').trim() || 'qwen-plus';

      if (!prompt) {
        return res.status(400).json({ error: '"prompt" is required.' });
      }

      const plan = await buildPeopleSearchPlan(prompt, model);
      if (!plan.searchKeywords) {
        return res.status(500).json({ error: 'Qwen returned an empty search plan.' });
      }

      return res.json(plan);
    } catch (err) {
      return res.status(500).json({
      error: `Failed to build people search plan: ${err.message}`,
    });
  }
});

app.post('/apollo/people/search', rateLimit, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const model = String(req.body?.model || 'qwen-plus').trim() || 'qwen-plus';
    const page = Math.max(1, parseInt(req.body?.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.body?.perPage, 10) || 10));

    if (!prompt) {
      return res.status(400).json({ error: '"prompt" is required.' });
    }

    const plan = await buildPeopleSearchPlan(prompt, model);
    const searchResult = await searchApolloPeople(plan, page, perPage);
    return res.json(searchResult);
  } catch (err) {
    return res.status(err?.statusCode || 500).json({
      error: `Failed to search Apollo people: ${err.message}`,
    });
  }
});

app.post('/apollo/people/enrich', rateLimit, async (req, res) => {
  try {
    const people = Array.isArray(req.body?.people) ? req.body.people : [];
    const revealPersonalEmails = !!req.body?.revealPersonalEmails;
    const revealPhoneNumber = !!req.body?.revealPhoneNumber;

    if (people.length === 0) {
      return res.status(400).json({ error: '"people" must be a non-empty array.' });
    }

    const results = await enrichApolloPeople(people, revealPersonalEmails, revealPhoneNumber);
    return res.json({ results });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({
      error: `Failed to enrich Apollo people: ${err.message}`,
    });
  }
});

app.post('/apollo/people/search-and-enrich', rateLimit, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const model = String(req.body?.model || 'qwen-plus').trim() || 'qwen-plus';
    const page = Math.max(1, parseInt(req.body?.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.body?.perPage, 10) || 10));
    const revealPersonalEmails = !!req.body?.revealPersonalEmails;
    const revealPhoneNumber = !!req.body?.revealPhoneNumber;

    if (!prompt) {
      return res.status(400).json({ error: '"prompt" is required.' });
    }

    const plan = await buildPeopleSearchPlan(prompt, model);
    const searchResult = await searchApolloPeople(plan, page, perPage);
    const enrichmentInput = searchResult.results.map((person) => ({
      name: person.name,
      first_name: person.firstName,
      last_name: person.lastName,
      organization_name: person.company,
      website_url: person.companyDomain,
      linkedin_url: person.linkedinUrl,
      email: person.emails?.[0] || '',
    }));
    const enrichedResults = await enrichApolloPeople(
      enrichmentInput,
      revealPersonalEmails,
      revealPhoneNumber
    );

    const mergedResults = searchResult.results.map((person, index) => ({
      ...person,
      emails: enrichedResults[index]?.emails || [],
      phones: enrichedResults[index]?.phones || [],
      apolloPersonId: enrichedResults[index]?.apolloPersonId || person.apolloPersonId,
    }));

    return res.json({
      results: mergedResults,
      pagination: searchResult.pagination,
      meta: searchResult.meta,
    });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({
      error: `Failed to search and enrich Apollo people: ${err.message}`,
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
    console.log(`   GET  /google/auth/start`);
    console.log(`   GET  /google/auth/callback`);
    console.log(`   GET  /google/auth/status`);
    console.log(`   POST /google/auth/disconnect`);
    console.log(`   POST /calendar/availability`);
    console.log(`   POST /calendar/events`);
    console.log(`   POST /linkedin/schedule/decide`);
    console.log(`   POST /apollo/people/search`);
    console.log(`   POST /apollo/people/enrich`);
    console.log(`   POST /apollo/people/search-and-enrich`);
    console.log(`   POST /linkedin/people-search/plan`);
    console.log(`   GET  /health         — Health check\n`);
  });
