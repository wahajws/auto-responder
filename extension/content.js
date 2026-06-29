/**
 * content.js - LinkedIn Auto-Reply (Qwen) Content Script
 *
 * File structure:
 *  - Shared runtime utilities and settings
 *  - Auto Reply feature
 *  - Contact Finder feature
 */

/* ============================================================
   Configuration & Constants
   ============================================================ */

const DEBUG = true; // Set to true for verbose console logging
const BACKEND_BASE_URL = 'http://localhost:3000';
const BACKEND_URL = `${BACKEND_BASE_URL}/linkedin/draft`;
const INJECTION_ID = 'qwen-autoreply-container';
const PANEL_ID = 'qwen-autoreply-panel';
const SEARCH_TOOL_ID = 'qwen-people-search-tool';
const MAX_MSG_LENGTH = 1000; // Truncate individual messages
const RETRY_MAX = 3; // Exponential backoff retries for backend calls
const OBSERVER_DEBOUNCE_MS = 500;
const SENDER_NAME_STORAGE_KEY = 'qwen_sender_names_by_thread';
const PENDING_AUTO_INTRO_KEY = 'qwen_pending_auto_intro';
const PENDING_AUTO_INTRO_TTL_MS = 10 * 60 * 1000;
const SCHED_STATE_STORAGE_KEY = 'qwen_schedule_state_by_thread';
const SCHEDULER_INTERVAL_MS = 7000;
const MEETING_OFFSET_OPTIONS = [
  { label: '0 min from now', ms: 0 },
  { label: '15 min from now', ms: 15 * 60 * 1000 },
  { label: '30 min from now', ms: 30 * 60 * 1000 },
  { label: '1 hour from now', ms: 60 * 60 * 1000 },
  { label: '2 hours from now', ms: 2 * 60 * 60 * 1000 },
  { label: '3 hours from now', ms: 3 * 60 * 60 * 1000 },
  { label: '1 day from now', ms: 24 * 60 * 60 * 1000 },
  { label: '2 days from now', ms: 2 * 24 * 60 * 60 * 1000 },
  { label: '3 days from now', ms: 3 * 24 * 60 * 60 * 1000 },
];
let cachedMyFirstName = '';

// Default settings (overridden by chrome.storage.sync)
let settings = {
  enabled: true,
  tone: 'professional',
  maxTurns: '10',
  showApproveSend: false,
  autoAcceptMyNetwork: false,
  autoIntroMyNetwork: false,
  autoAcceptMyNetworkIntro: false,
  calendarSchedulingEnabled: false,
  autoReplyContinuously: false,
  calendarConnected: false,
  senderFirstName: '',
  senderHeadline: '',
};
let promptedForFirstNameThisSession = false;
let promptedForHeadlineThisSession = false;

let isAutoAcceptRunning = false;
let lastAutoAcceptRunAt = 0;
const processedInviteIds = new Set();
const AUTO_ACCEPT_COOLDOWN_MS = 8000;
const AUTO_ACCEPT_ACCEPT_WAIT_MS = 7000;
const AUTO_ACCEPT_COMPOSER_WAIT_MS = 8000;
let isProcessingPendingAutoIntro = false;
let schedulerIntervalId = null;
let isSchedulerTickRunning = false;
let observerInstance = null;
let extensionContextActive = true;
let isSearchContactFetchRunning = false;
let peopleSearchToolManuallyClosed = false;
let contactFinderMessageHandlersRegistered = false;

function log(...args) {
  if (DEBUG) console.log('[Qwen AutoReply]', ...args);
}

function logError(...args) {
  console.error('[Qwen AutoReply]', ...args);
}

function isExtensionContextValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  } catch (_err) {
    return false;
  }
}

function disableExtensionRuntime(reason = 'unknown') {
  if (!extensionContextActive) return;
  extensionContextActive = false;
  clearTimeout(observerDebounceTimer);
  if (schedulerIntervalId) {
    clearInterval(schedulerIntervalId);
    schedulerIntervalId = null;
  }
  if (observerInstance) {
    observerInstance.disconnect();
    observerInstance = null;
  }
  logError('Extension runtime disabled:', reason);
}

function storageGet(area, key) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      disableExtensionRuntime('storageGet-invalid-context');
      resolve(undefined);
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage[area]) {
      resolve(undefined);
      return;
    }
    try {
      chrome.storage[area].get([key], (result) => resolve(result?.[key]));
    } catch (err) {
      logError('storageGet failed:', err);
      resolve(undefined);
    }
  });
}

function storageSet(area, value) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      disableExtensionRuntime('storageSet-invalid-context');
      resolve();
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage[area]) {
      resolve();
      return;
    }
    try {
      chrome.storage[area].set(value, () => resolve());
    } catch (err) {
      logError('storageSet failed:', err);
      resolve();
    }
  });
}

function storageRemove(area, key) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      disableExtensionRuntime('storageRemove-invalid-context');
      resolve();
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage[area]) {
      resolve();
      return;
    }
    try {
      chrome.storage[area].remove([key], () => resolve());
    } catch (err) {
      logError('storageRemove failed:', err);
      resolve();
    }
  });
}

function getThreadId() {
  const href = window.location.href || '';
  const match = href.match(/\/messaging\/thread\/([^/?#]+)/i);
  if (match && match[1]) return match[1];

  const urnNode = document.querySelector('[data-urn*="messaging-thread"], [data-urn*="fsd_message"]');
  const urn = urnNode?.getAttribute('data-urn') || '';
  if (urn) return urn;

  return 'current';
}

function cleanPersonName(name) {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\b(you|linkedin|messaging)\b/gi, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function extractFirstName(name) {
  const cleaned = cleanPersonName(name);
  if (!cleaned) return '';

  const withoutSuffix = cleaned.replace(/\b(MBA|PhD|MD|Jr|Sr|II|III|IV)\b\.?/gi, '').trim();
  const parts = withoutSuffix.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return '';

  let first = parts[0].replace(/[^A-Za-z'-]/g, '');
  if (!first) return '';

  // Normalize casing to avoid shout-case names.
  first = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return first;
}

function extractSenderFullNameFromThread() {
  const selectors = [
    // Main conversation header name (top of thread)
    'h2.msg-entity-lockup__entity-title',
    // Name label above message groups in the chat
    'span.msg-s-message-group__profile-link.msg-s-message-group__name',
    // Profile-card "New message" / profile page header name
    'a.profile-card-one-to-one__profile-link span.truncate',
    // Fallback: any truncate span under a profile-card link wrapper
    'span.display-flex.truncate.align-items-center a.profile-card-one-to-one__profile-link span.truncate',
    '.msg-thread__link-to-profile .msg-thread__subject',
    '.msg-overlay-bubble-header__title',
    '.msg-thread__thread-title',
    '.msg-s-message-group__name',
    'a[href*="/in/"] span[aria-hidden="true"]',
    '[data-control-name="overlay.close_conversation_window"] ~ * [aria-hidden="true"]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const name = cleanPersonName(el.innerText || el.textContent || '');
    if (name && !/^you$/i.test(name)) return name;
  }

  return '';
}

function extractIntroducedFirstName(conversation) {
  if (!Array.isArray(conversation)) return '';

  const introPatterns = [
    /\b(?:my name is|i am|i'm|im|this is)\s+([A-Za-z][A-Za-z'-]{1,30})\b/i,
    /\b(?:it's|its)\s+([A-Za-z][A-Za-z'-]{1,30})\b/i,
  ];

  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i];
    if (!msg || msg.role !== 'them' || typeof msg.text !== 'string') continue;

    for (const re of introPatterns) {
      const match = msg.text.match(re);
      if (!match || !match[1]) continue;
      const first = extractFirstName(match[1]);
      if (first && !/^(I|Im|It|Its|This)$/i.test(first)) return first;
    }
  }

  return '';
}

async function resolveSenderFirstName(conversation) {
  const threadId = getThreadId();
  const nameMap = (await storageGet('local', SENDER_NAME_STORAGE_KEY)) || {};
  const cached = nameMap[threadId] || {};

  const detectedFullName = extractSenderFullNameFromThread();
  const detectedFirstName = extractFirstName(detectedFullName);

  if (detectedFullName && detectedFirstName) {
    nameMap[threadId] = {
      fullName: detectedFullName,
      firstName: detectedFirstName,
      updatedAt: Date.now(),
    };
    await storageSet('local', { [SENDER_NAME_STORAGE_KEY]: nameMap });
  }

  const introducedFirstName = extractIntroducedFirstName(conversation);
  if (introducedFirstName) return introducedFirstName;

  return detectedFirstName || cached.firstName || '';
}

function applyRecipientNameFallback(draft, firstName) {
  if (!draft) return draft;

  // Hard-disable em/en/horizontal dashes in UI draft text.
  let normalized = draft.replace(/[\u2012\u2013\u2014\u2015]/g, '-');

  if (!firstName) return normalized;
  return normalized.replace(/\[Name\]/gi, firstName);
}

function extractMyFirstName() {
  if (cachedMyFirstName) return cachedMyFirstName;

  const selectors = [
    '.global-nav__me span[aria-hidden="true"]',
    '.global-nav__me-photo + span',
    '[data-control-name="identity_welcome_message"]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = (el.innerText || el.textContent || '').trim();
    const first = extractFirstName(text);
    // Ignore generic labels like "Me" which are not real names
    if (first && !/^(me|you)$/i.test(first)) {
      cachedMyFirstName = first;
      return first;
    }
  }

  // Fallback: use the alt text from the global nav profile photo
  const mePhoto = document.querySelector('img.global-nav__me-photo[alt]');
  if (mePhoto) {
    const altText = (mePhoto.getAttribute('alt') || '').trim();
    const first = extractFirstName(altText);
    if (first) {
      cachedMyFirstName = first;
      return first;
    }
  }

  return '';
}

/**
 * Normalizes a LinkedIn profile headline string and truncates it to the main role/company
 * by cutting before common separators like "|" or "•".
 * @param {string} raw
 * @returns {string}
 */
function normalizeHeadlineSnippet(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw.replace(/\s+/g, ' ').trim();

  // Remove surrounding quotation marks if present
  text = text.replace(/^"+|"+$/g, '').trim();
  if (!text) return '';

  // Cut at the first common divider (|, •, ·) with spaces around it
  const parts = text.split(/\s[|•·]\s/);
  text = (parts[0] || text).trim();

  return text;
}

function getHeadlineFromOpenMeMenu() {
  const menuList = document.querySelector(
    'ul[aria-label="Me menu"], ul[aria-label*="Me"], .global-nav__me-menu ul[role="menu"], .global-nav__me-menu ul[aria-label]'
  );
  if (!menuList) return '';

  const menuRoot =
    menuList.closest('.global-nav__me-menu') ||
    menuList.closest('[role="menu"]') ||
    menuList.parentElement;
  if (!menuRoot) return '';

  const subtitle =
    menuRoot.querySelector('.artdeco-entity-lockup__subtitle') ||
    menuRoot.querySelector('[class*="entity-lockup__subtitle"]');
  if (!subtitle) return '';

  const raw =
    subtitle.getAttribute('title') ||
    subtitle.getAttribute('aria-label') ||
    subtitle.innerText ||
    subtitle.textContent ||
    '';

  return normalizeHeadlineSnippet(raw);
}

function getHeadlineFromSidebar() {
  const selectors = [
    '.profile-card-member-details .profile-card-headline',
    'a.profile-card-one-to-one__profile-link p.profile-card-headline',
    '.artdeco-card .profile-card-headline',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const raw =
      el.getAttribute('title') ||
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.textContent ||
      '';
    const snippet = normalizeHeadlineSnippet(raw);
    if (snippet) return snippet;
  }

  return '';
}

/**
 * Attempts to read the current user's profile headline (role/company)
 * from visible LinkedIn UI.
 * @returns {string}
 */
function extractMyHeadline() {
  const fromOpenMeMenu = getHeadlineFromOpenMeMenu();
  if (fromOpenMeMenu) return fromOpenMeMenu;

  const fromSidebar = getHeadlineFromSidebar();
  if (fromSidebar) return fromSidebar;

  const selectors = [
    // Subtitle in the "Me" dropdown in the global nav
    '.global-nav__me .artdeco-entity-lockup__subtitle',
    '.global-nav__me div.artdeco-entity-lockup__subtitle',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const raw = (el.innerText || el.textContent || '').trim();
    const snippet = normalizeHeadlineSnippet(raw);
    if (snippet) return snippet;
  }

  return '';
}

function needsSenderProfileEnrichment() {
  const first = (settings.senderFirstName || '').trim();
  const headline = (settings.senderHeadline || '').trim();
  return !first || !headline;
}

function needsFirstNamePrompt() {
  return !(settings.senderFirstName || '').trim() && !promptedForFirstNameThisSession;
}

function needsHeadlinePrompt() {
  return !(settings.senderHeadline || '').trim() && !promptedForHeadlineThisSession;
}

/**
 * If we don't yet have a saved sender profile, try to detect it from the
 * current page and offer to save it to settings so it persists across pages.
 */
async function maybePromptToSaveProfile() {
  if (!needsFirstNamePrompt() && !needsHeadlinePrompt()) return;
  if (/^\/in\//i.test(window.location.pathname || '')) return;

  const currentFirst = (settings.senderFirstName || '').trim();
  const currentHeadline = (settings.senderHeadline || '').trim();

  // If we already have both a name and a headline saved, nothing to do.
  if (currentFirst && currentHeadline) return;

  // Try to detect missing pieces from the page.
  let detectedFirst = currentFirst || extractMyFirstName();
  let detectedHeadline = currentHeadline;
  if (!detectedHeadline) {
    detectedHeadline = extractMyHeadline();
  }

  const update = {};
  if (needsFirstNamePrompt() && detectedFirst) {
    update.senderFirstName = detectedFirst;
  }
  if (needsHeadlinePrompt() && detectedHeadline) {
    update.senderHeadline = detectedHeadline;
  }

  const attemptedFirstName = needsFirstNamePrompt() && !!detectedFirst;
  const attemptedHeadline = needsHeadlinePrompt() && !!detectedHeadline;

  const headlinePart = detectedHeadline ? `, "${detectedHeadline}"` : '';
  const nameForPrompt = detectedFirst || currentFirst || 'your profile';
  const confirmMsg =
    `Profile detected!\n\n` +
    `Would you like to save "${nameForPrompt}"${headlinePart} for future messages?`;

  if (Object.keys(update).length > 0 && window.confirm(confirmMsg)) {
    await storageSet('sync', update);
    settings = { ...settings, ...update };
  }

  if (attemptedFirstName) promptedForFirstNameThisSession = true;
  if (attemptedHeadline) promptedForHeadlineThisSession = true;
}

/* ============================================================
   Settings Loader
   ============================================================ */

function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(settings, (stored) => {
        settings = { ...settings, ...stored };
        if (settings.autoAcceptMyNetworkIntro && !settings.autoAcceptMyNetwork && !settings.autoIntroMyNetwork) {
          settings.autoAcceptMyNetwork = true;
          settings.autoIntroMyNetwork = true;
        }
        log('Settings loaded:', settings);
        resolve();
      });
    } else {
      log('chrome.storage not available, using defaults');
      resolve();
    }
  });
}

// Listen for settings changes in real-time
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in settings) {
        settings[key] = newValue;
        log(`Setting "${key}" changed to:`, newValue);
      }

      if (key === 'senderFirstName' && newValue) {
        promptedForFirstNameThisSession = false;
      }
      if (key === 'senderHeadline' && newValue) {
        promptedForHeadlineThisSession = false;
      }
    }
    // Re-evaluate injection
    if ('enabled' in changes) {
      if (settings.enabled) {
        tryInject();
        runAutoAcceptAndIntroBatch('settings-enabled');
        startCalendarScheduler();
        runCalendarSchedulerTick('settings-enabled');
      } else {
        removeInjectedUI();
      }
    }

    if (
      ('autoAcceptMyNetwork' in changes && settings.autoAcceptMyNetwork) ||
      ('autoIntroMyNetwork' in changes && settings.autoIntroMyNetwork) ||
      ('autoAcceptMyNetworkIntro' in changes && settings.autoAcceptMyNetworkIntro)
    ) {
      runAutoAcceptAndIntroBatch('settings-network-automation-toggle');
    }

    if ('calendarSchedulingEnabled' in changes && settings.calendarSchedulingEnabled) {
      startCalendarScheduler();
      runCalendarSchedulerTick('settings-calendar-toggle');
    }
    if ('autoReplyContinuously' in changes && settings.autoReplyContinuously) {
      startCalendarScheduler();
      runCalendarSchedulerTick('settings-auto-reply-toggle');
    }
  });
}

/* ============================================================
   Feature: Auto Reply
   ============================================================ */

/* ============================================================
   Composer Detection - Multiple Selector Fallbacks
   ============================================================ */

/**
 * Attempts to find the LinkedIn messaging composer textbox.
 * Uses multiple selectors with fallbacks for robustness.
 * @returns {HTMLElement|null}
 */
function isElementVisible(el) {
  if (!el) return false;
  return !!(el.offsetParent || el.getClientRects().length);
}

function isMessagingComposerCandidate(el) {
  if (!el) return false;

  const messagingContainerSelectors = [
    'form.msg-form',
    '.msg-form',
    '.msg-convo-wrapper',
    '.msg-overlay-conversation-bubble',
    '.msg-overlay-list-bubble',
    '.msg-thread',
    '.msg-s-message-list-container',
  ];

  const blockedContainerSelectors = [
    '.comments-comment-box',
    '.comments-comment-item',
    '.feed-shared-update-v2',
    '.feed-shared-inline-show-more-text',
    '.share-box-feed-entry__closed-share-box',
    '.editor-content',
  ];

  const inMessagingContainer = messagingContainerSelectors.some((sel) => !!el.closest(sel));
  if (!inMessagingContainer) return false;

  const inBlockedContainer = blockedContainerSelectors.some((sel) => !!el.closest(sel));
  if (inBlockedContainer) return false;

  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  if (ariaLabel.includes('comment') && !ariaLabel.includes('message')) return false;

  return true;
}

function findComposer() {
  const selectors = [
    // Primary: contenteditable with role="textbox" inside messaging
    '.msg-form__contenteditable [role="textbox"]',
    '.msg-form__contenteditable div[contenteditable="true"]',
    'div.msg-form__contenteditable',
    // Fallback: broader selectors
    'form.msg-form div[role="textbox"]',
    'form.msg-form div[contenteditable="true"]',
    // Generic fallback
    '.msg-convo-wrapper div[role="textbox"]',
    'div[data-artdeco-is-focused] div[role="textbox"]',
    // Very broad fallback
    'div.msg-s-message-list-container ~ * div[role="textbox"]',
    'div[contenteditable="true"][aria-label]',
  ];

  for (const sel of selectors) {
    try {
      const candidates = Array.from(document.querySelectorAll(sel));
      for (const el of candidates) {
        if (!isElementVisible(el)) continue;
        if (!isMessagingComposerCandidate(el)) continue;
        log('Composer found with selector:', sel);
        return el;
      }
    } catch (e) {
      // Invalid selector, skip
    }
  }

  log('Composer not found');
  return null;
}

/**
 * Finds the form container wrapping the composer for positioning.
 * @param {HTMLElement} composer
 * @returns {HTMLElement}
 */
function findComposerFormContainer(composer) {
  const formSelectors = [
    'form.msg-form',
    '.msg-form',
    '.msg-form__msg-content-container',
  ];

  for (const sel of formSelectors) {
    const form = composer.closest(sel) || document.querySelector(sel);
    if (form) return form;
  }

  // Fallback: walk up to find a suitable parent
  let parent = composer.parentElement;
  for (let i = 0; i < 6 && parent; i++) {
    if (parent.tagName === 'FORM' || parent.classList.contains('msg-form')) {
      return parent;
    }
    parent = parent.parentElement;
  }

  return composer.parentElement;
}

/* ============================================================
   Conversation Extraction
   ============================================================ */

/**
 * Extracts the last N messages from the active conversation thread.
 * @returns {Array<{role: string, text: string}>}
 */
function extractConversation() {
  // Selectors for individual message items
  const messageListSelectors = [
    '.msg-s-message-list-content .msg-s-event-listitem',
    '.msg-s-message-list-content li.msg-s-message-list__event',
    '.msg-s-message-list .msg-s-event-listitem',
    'ul.msg-s-message-list-content > li',
    '.msg-s-message-list-content > li',
    // Newer LinkedIn layouts
    '.msg-s-event-listitem',
    'li[class*="msg-s-event-listitem"]',
    // Very broad
    '.msg-thread .msg-s-event-listitem',
  ];

  let messageNodes = [];
  for (const sel of messageListSelectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        messageNodes = Array.from(nodes);
        log(`Found ${messageNodes.length} message nodes with: ${sel}`);
        break;
      }
    } catch (e) { /* skip */ }
  }

  if (messageNodes.length === 0) {
    log('No message nodes found');
    return [];
  }

  const maxTurns = resolveMaxTurns(settings.maxTurns, messageNodes.length);

  // Take the last N nodes
  const recentNodes = messageNodes.slice(-maxTurns);

  const conversation = [];

  for (const node of recentNodes) {
    // Extract text content
    const textSelectors = [
      '.msg-s-event-listitem__body',
      '.msg-s-event__content',
      'p.msg-s-event-listitem__body',
      '.msg-s-message-body',
      'p',
    ];

    let text = '';
    for (const ts of textSelectors) {
      const textEl = node.querySelector(ts);
      if (textEl) {
        text = textEl.innerText || textEl.textContent || '';
        break;
      }
    }

    if (!text) {
      // Try the node itself
      text = node.innerText || node.textContent || '';
    }

    // Clean the text
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // Truncate
    if (text.length > MAX_MSG_LENGTH) {
      text = text.substring(0, MAX_MSG_LENGTH) + '...';
    }

    // Determine role: "me" vs "them"
    const role = classifyMessageRole(node);

    conversation.push({ role, text });
  }

  log('Extracted conversation:', conversation);
  return conversation;
}

/**
 * Resolves max turns setting to an integer based on available message count.
 * Supports symbolic values and legacy numeric values.
 * @param {string|number} rawValue
 * @param {number} totalCount
 * @returns {number}
 */
function resolveMaxTurns(rawValue, totalCount) {
  if (rawValue === 'all') return totalCount;
  if (rawValue === 'most-recent') return 1;

  if (rawValue === '5' || rawValue === 5) return Math.min(5, totalCount);
  if (rawValue === '10' || rawValue === 10) return Math.min(10, totalCount);

  const numeric = parseInt(rawValue, 10);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return Math.min(numeric, totalCount);
  }

  return Math.min(10, totalCount);
}

/**
 * Heuristic to determine if a message was sent by "me" or "them".
 * Uses multiple signals with fallbacks.
 * @param {HTMLElement} node
 * @returns {"me"|"them"}
 */
function classifyMessageRole(node) {
  // Signal 1: Check for classes indicating sent messages
  const nodeClasses = node.className || '';
  const nodeHTML = node.outerHTML || '';
  const myFirstName = (extractMyFirstName() || '').trim().toLowerCase();
  const myFullName = cleanPersonName(
    document.querySelector('.global-nav__me span[aria-hidden="true"]')?.innerText ||
    document.querySelector('.global-nav__me span[aria-hidden="true"]')?.textContent ||
    ''
  ).toLowerCase();

  if (/msg-s-event-listitem--other/i.test(nodeClasses)) return 'them';
  if (/msg-s-event-listitem--self/i.test(nodeClasses) ||
      /msg-s-event-listitem--outgoing/i.test(nodeClasses)) return 'me';

  // Signal 2: Check for "You" sender label
  const senderSelectors = [
    '.msg-s-message-group__name',
    '.msg-s-event-listitem__header .visually-hidden',
    '.msg-s-message-group__meta .msg-s-message-group__name',
    'span[class*="msg-s-message-group__name"]',
  ];

  for (const sel of senderSelectors) {
    const senderEl = node.querySelector(sel) ||
                     (node.closest('.msg-s-message-group') || node.parentElement)?.querySelector(sel);
    if (senderEl) {
      const senderText = (senderEl.innerText || senderEl.textContent || '').trim();
      const senderLower = senderText.toLowerCase();
      if (/^you$/i.test(senderText)) return 'me';
      if (myFirstName && senderLower === myFirstName) return 'me';
      if (myFullName && senderLower === myFullName) return 'me';
      if (myFirstName && senderLower.startsWith(`${myFirstName} `)) return 'me';
      if (senderText.length > 0) return 'them';
    }
  }

  // Signal 3: Check aria-label / accessibility attributes
  const ariaLabel = node.getAttribute('aria-label') || '';
  if (/\byou\b/i.test(ariaLabel) && /\bsent\b/i.test(ariaLabel)) return 'me';
  if (myFirstName && ariaLabel.toLowerCase().includes(myFirstName) && /\bsent\b/i.test(ariaLabel)) return 'me';
  if (myFullName && ariaLabel.toLowerCase().includes(myFullName) && /\bsent\b/i.test(ariaLabel)) return 'me';

  // Signal 4: Check for message alignment (LinkedIn sometimes aligns sent messages differently)
  const groupParent = node.closest('.msg-s-message-group');
  if (groupParent) {
    const gpClasses = groupParent.className || '';
    if (/msg-s-message-group--outgoing/i.test(gpClasses) ||
        /msg-s-message-group--self/i.test(gpClasses)) return 'me';
    if (/msg-s-message-group--incoming/i.test(gpClasses) ||
        /msg-s-message-group--other/i.test(gpClasses)) return 'them';
  }

  // Signal 5: Presence of the user's avatar in the group
  // If no clear signal, default to "them"
  return 'them';
}

/* ============================================================
   Backend Communication with Retry
   ============================================================ */

/**
 * Calls the backend /linkedin/draft endpoint with exponential backoff.
 * @param {Object} payload
 * @returns {Promise<string>} The generated draft text
 */
async function callBackend(payload) {
  let lastError;

  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    try {
      log(`Backend call attempt ${attempt + 1}/${RETRY_MAX}`);

      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errBody}`);
      }

      const data = await response.json();
      if (!data.draft) {
        throw new Error('Empty draft in response');
      }

      return data.draft;
    } catch (err) {
      lastError = err;
      logError(`Attempt ${attempt + 1} failed:`, err.message);

      if (attempt < RETRY_MAX - 1) {
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
        log(`Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

async function callApi(path, payload = undefined, method = 'POST') {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  return response.json();
}

/* ============================================================
   Insert Draft into LinkedIn Composer
   ============================================================ */

/**
 * Inserts text into the LinkedIn contenteditable composer.
 * @param {string} text
 * @returns {boolean} success
 */
function insertDraftIntoComposer(text) {
  const composer = findComposer();
  if (!composer) {
    logError('Cannot insert: composer not found');
    return false;
  }

  try {
    // Focus the composer
    composer.focus();

    const normalizedText = String(text || '').replace(/\r\n/g, '\n');

    // Use paragraph nodes so LinkedIn treats line breaks like real Enter presses.
    composer.innerHTML = '';
    const lines = normalizedText.split('\n');
    lines.forEach((line) => {
      const p = document.createElement('p');
      if (line.length > 0) {
        p.textContent = line;
      } else {
        p.appendChild(document.createElement('br'));
      }
      composer.appendChild(p);
    });

    // Dispatch input event so LinkedIn picks up the change
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: normalizedText,
    });
    composer.dispatchEvent(inputEvent);

    // Also dispatch a generic Event for older listeners
    composer.dispatchEvent(new Event('change', { bubbles: true }));

    log('Draft inserted into composer');
    return true;
  } catch (err) {
    logError('Failed to insert draft:', err);
    return false;
  }
}

/* ============================================================
   Find & Click LinkedIn Send Button
   ============================================================ */

/**
 * Finds and clicks the LinkedIn Send button.
 * @returns {boolean}
 */
function clickSendButton() {
  const sendSelectors = [
    'button.msg-form__send-button',
    'button[type="submit"].msg-form__send-button',
    'button.msg-form__send-btn',
    'form.msg-form button[type="submit"]',
    '.msg-form__right-actions button[type="submit"]',
    'button[data-control-name="send"]',
    // Broad fallback
    'form.msg-form button:not([disabled])',
  ];

  for (const sel of sendSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        log('Send button found:', sel);
        btn.click();
        return true;
      }
    } catch (e) { /* skip */ }
  }

  logError('Send button not found');
  return false;
}

/* ============================================================
   My Network Auto-Accept + Intro
   ============================================================ */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const floorMin = Math.ceil(min);
  const floorMax = Math.floor(max);
  return Math.floor(Math.random() * (floorMax - floorMin + 1)) + floorMin;
}

async function waitForCondition(checkFn, timeoutMs = 5000, intervalMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (checkFn()) return true;
    } catch (_err) {
      // Ignore transient DOM errors while polling.
    }
    await wait(intervalMs);
  }
  return false;
}

function isMyNetworkInvitationsPage() {
  const path = (window.location.pathname || '').toLowerCase();
  const isInvitationRoute = path.startsWith('/mynetwork');

  if (!isInvitationRoute) return false;

  const listSelectors = [
    'main section',
    'ul.invitation-card__list',
    '.mn-invitation-manager__container',
    '[data-view-name="pending-invitations"]',
  ];

  return listSelectors.some((sel) => {
    try {
      return !!document.querySelector(sel);
    } catch (_err) {
      return false;
    }
  });
}

function findButtonByText(root, matcher) {
  const buttons = root.querySelectorAll('button');
  for (const btn of buttons) {
    const text = (btn.innerText || btn.textContent || '').trim();
    if (!btn.disabled && matcher.test(text)) return btn;
  }
  return null;
}

function findAcceptButton(card) {
  const selectors = [
    'button[aria-label*="Accept"]',
    'button[aria-label*="accept"]',
    'button[data-control-name*="accept"]',
    'button.artdeco-button--secondary',
  ];

  for (const sel of selectors) {
    const btn = card.querySelector(sel);
    if (btn && !btn.disabled && /accept/i.test((btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim())) {
      return btn;
    }
  }

  return findButtonByText(card, /^accept$/i);
}

function findMessageButton(card) {
  const selectors = [
    'button[aria-label*="Message"]',
    'button[aria-label*="message"]',
    'button[data-control-name*="message"]',
  ];

  for (const sel of selectors) {
    const btn = card.querySelector(sel);
    if (btn && !btn.disabled) return btn;
  }

  return findButtonByText(card, /^message$/i);
}

function findPendingInvitationCards() {
  const selectors = [
    'li.invitation-card',
    '.invitation-card',
    '[data-view-name="pending-invitation"]',
    'li[data-view-name*="invitation"]',
  ];

  for (const sel of selectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    const pending = nodes.filter((node) => !!findAcceptButton(node));
    if (pending.length > 0) return pending;
  }

  return [];
}

function getInviteIdFromCard(card, idx) {
  const dataKeys = ['invitationId', 'entityUrn', 'urn', 'id', 'testId', 'viewName'];
  for (const key of dataKeys) {
    const value = card.dataset?.[key];
    if (value) return `dataset:${key}:${value}`;
  }

  const attrs = ['data-id', 'data-urn', 'data-entity-urn', 'id'];
  for (const attr of attrs) {
    const value = card.getAttribute(attr);
    if (value) return `attr:${attr}:${value}`;
  }

  const profileLink = card.querySelector('a[href*="/in/"]');
  const href = profileLink?.getAttribute('href') || '';
  if (href) return `href:${href.split('?')[0]}`;

  const name = extractInviteFirstName(card) || `index-${idx}`;
  return `fallback:${name}:${idx}`;
}

function extractInviteFirstName(card) {
  const selectors = [
    '.invitation-card__title',
    '.discover-person-card__name',
    'a[href*="/in/"] span[aria-hidden="true"]',
    'span[aria-hidden="true"]',
  ];

  for (const sel of selectors) {
    const el = card.querySelector(sel);
    if (!el) continue;
    const text = cleanPersonName(el.innerText || el.textContent || '');
    const first = extractFirstName(text);
    if (first) return first;
  }

  return '';
}

async function clickAcceptOnCard(card, inviteId) {
  const acceptBtn = findAcceptButton(card);
  if (!acceptBtn) {
    log('Skipping invite; Accept button not found', inviteId);
    return false;
  }

  acceptBtn.click();

  const accepted = await waitForCondition(
    () => !document.body.contains(card) || !findAcceptButton(card),
    AUTO_ACCEPT_ACCEPT_WAIT_MS,
    200
  );

  if (!accepted) {
    log('Accept confirmation timed out; skipping intro send for invite', inviteId);
    return false;
  }

  return true;
}

function findInlineConfirmationMessageLink(card, recipientFirstName) {
  const links = Array.from(
    document.querySelectorAll(
      'a[data-view-name="invitation-inline-confirmation-message"], a[href*="/messaging/compose/"]'
    )
  );

  if (links.length === 0) return null;

  const normalizedName = (recipientFirstName || '').trim().toLowerCase();

  // Prefer links near the current invite card.
  if (card) {
    const nearest = links.find((link) => {
      const inlineRoot =
        link.closest('[data-view-name="invitation-inline-confirmation"]') ||
        link.closest('[data-view-name="invitation-inline-confirmation-message"]') ||
        link.closest('section') ||
        link.closest('li');
      if (!inlineRoot) return false;
      return inlineRoot.contains(card) || card.contains(inlineRoot);
    });
    if (nearest) return nearest;
  }

  if (normalizedName) {
    const byName = links.find((link) => {
      const text = (link.innerText || link.textContent || '').trim().toLowerCase();
      return text.includes(normalizedName);
    });
    if (byName) return byName;
  }

  return links[links.length - 1];
}

async function openComposerViaInlineMessageLink(card, recipientFirstName, inviteId, draft) {
  const messageLink = findInlineConfirmationMessageLink(card, recipientFirstName);
  if (!messageLink) return 'not_found';

  const href = messageLink.getAttribute('href') || '';
  const isNavigationComposeLink = /\/messaging\/compose\//i.test(href);
  if (isNavigationComposeLink) {
    await storageSet('local', {
      [PENDING_AUTO_INTRO_KEY]: {
        draft: String(draft || ''),
        recipientFirstName: recipientFirstName || '',
        inviteId,
        createdAt: Date.now(),
        source: 'inline_confirmation_link',
      },
    });
    messageLink.click();
    return 'navigating';
  }

  messageLink.click();

  const opened = await waitForCondition(
    () => !!findComposer(),
    AUTO_ACCEPT_COMPOSER_WAIT_MS,
    250
  );
  if (!opened) {
    log('Inline message link clicked but composer did not open', inviteId);
    return 'failed';
  }

  return 'opened';
}

function findMessagingSearchInput() {
  const selectors = [
    'input[aria-label*="Search messages"]',
    'input[placeholder*="Search messages"]',
    '.msg-overlay-list-bubble input[type="search"]',
    '.msg-overlay-list-bubble input[type="text"]',
  ];

  for (const sel of selectors) {
    const input = document.querySelector(sel);
    if (input) return input;
  }
  return null;
}

function findThreadListItemByName(recipientFirstName) {
  if (!recipientFirstName) return null;

  const normalizedName = recipientFirstName.toLowerCase();
  const selectors = [
    '.msg-conversations-container__convo-item-link',
    '.msg-conversation-listitem',
    '.msg-overlay-conversations-container__conversation-item',
    '[data-view-name*="message-thread"]',
  ];

  for (const sel of selectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    const match = nodes.find((node) =>
      (node.innerText || node.textContent || '').toLowerCase().includes(normalizedName)
    );
    if (match) return match;
  }

  return null;
}

async function openComposerViaMessagingSearch(recipientFirstName, inviteId) {
  const searchInput = findMessagingSearchInput();
  if (!searchInput) {
    log('Messaging search input not found for fallback', inviteId);
    return false;
  }

  searchInput.focus();
  searchInput.value = recipientFirstName || '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

  const threadFound = await waitForCondition(
    () => !!findThreadListItemByName(recipientFirstName),
    4000,
    250
  );
  if (!threadFound) {
    log('No messaging thread found from search fallback', inviteId);
    return false;
  }

  const thread = findThreadListItemByName(recipientFirstName);
  if (!thread) return false;
  thread.click();

  const opened = await waitForCondition(
    () => !!findComposer(),
    AUTO_ACCEPT_COMPOSER_WAIT_MS,
    250
  );

  if (!opened) {
    log('Composer did not open after messaging search fallback', inviteId);
    return false;
  }

  return true;
}

async function openMessageComposerFromCard(card, recipientFirstName, inviteId, draft) {
  const openedViaSearch = await openComposerViaMessagingSearch(recipientFirstName, inviteId);
  if (openedViaSearch) return 'opened';

  const messageBtn = findMessageButton(card);
  if (messageBtn) {
    messageBtn.click();
    const opened = await waitForCondition(
      () => !!findComposer(),
      AUTO_ACCEPT_COMPOSER_WAIT_MS,
      250
    );
    if (opened) return 'opened';
    log('Composer did not open after message button click', inviteId);
  }

  const inlineResult = await openComposerViaInlineMessageLink(card, recipientFirstName, inviteId, draft);
  if (inlineResult === 'opened' || inlineResult === 'navigating') {
    return inlineResult;
  }

  log('Message open failed for all fallback paths; skipping intro send', inviteId);
  return 'failed';
}

async function processPendingAutoIntroOnMessagingPage() {
  if (isProcessingPendingAutoIntro) return;
  if (!settings.enabled) return;

  const path = (window.location.pathname || '').toLowerCase();
  if (!path.startsWith('/messaging')) return;

  const pending = await storageGet('local', PENDING_AUTO_INTRO_KEY);
  if (!pending || typeof pending !== 'object') return;

  const createdAt = Number(pending.createdAt || 0);
  if (!createdAt || Date.now() - createdAt > PENDING_AUTO_INTRO_TTL_MS) {
    await storageRemove('local', PENDING_AUTO_INTRO_KEY);
    return;
  }

  const draft = String(pending.draft || '').trim();
  if (!draft) {
    await storageRemove('local', PENDING_AUTO_INTRO_KEY);
    return;
  }

  isProcessingPendingAutoIntro = true;
  try {
    const opened = await waitForCondition(
      () => !!findComposer(),
      AUTO_ACCEPT_COMPOSER_WAIT_MS * 2,
      300
    );
    if (!opened) return;

    const inserted = insertDraftIntoComposer(draft);
    if (!inserted) return;

    await wait(300);
    const sent = clickSendButton();
    if (!sent) return;

    await storageRemove('local', PENDING_AUTO_INTRO_KEY);
    log('Pending auto-intro sent from compose fallback.');
  } finally {
    isProcessingPendingAutoIntro = false;
  }
}

async function generateIntroDraftForInvite(recipientFirstName) {
  const senderFirstName = (settings.senderFirstName || '').trim();
  const senderHeadline = (settings.senderHeadline || '').trim();

  const draft = await callBackend({
    conversation: [],
    tone: settings.tone || 'professional',
    recipientFirstName: recipientFirstName || '',
    senderFirstName,
    senderHeadline,
    starterTemplate: 'connected_with_you',
    model: 'qwen-plus',
    redact: false,
  });

  return applyRecipientNameFallback(draft, recipientFirstName || '');
}

async function runAutoAcceptAndIntroBatch(trigger = 'unknown') {
  if (!settings.enabled) return;
  const shouldAutoAccept = settings.autoAcceptMyNetwork || settings.autoAcceptMyNetworkIntro;
  const autoIntroEnabled = settings.autoIntroMyNetwork || settings.autoAcceptMyNetworkIntro;
  const shouldAutoIntro = shouldAutoAccept && autoIntroEnabled;
  if (!shouldAutoAccept && !shouldAutoIntro) return;
  if (!shouldAutoAccept && autoIntroEnabled) {
    log('Auto-intro is enabled but auto-accept is off; intro is gated and will not run.');
  }
  if (!isMyNetworkInvitationsPage()) return;
  if (isAutoAcceptRunning) return;

  const now = Date.now();
  if (now - lastAutoAcceptRunAt < AUTO_ACCEPT_COOLDOWN_MS) return;

  isAutoAcceptRunning = true;
  lastAutoAcceptRunAt = now;

  try {
    const cards = findPendingInvitationCards();
    if (cards.length === 0) {
      log(`Auto-accept (${trigger}): no pending invitations found`);
      return;
    }

    log(`Auto-accept (${trigger}): processing ${cards.length} invitation(s)`);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!card || !document.body.contains(card)) continue;

      const inviteId = getInviteIdFromCard(card, i);
      if (processedInviteIds.has(inviteId)) continue;

      const recipientFirstName = extractInviteFirstName(card);

      try {
        if (shouldAutoAccept) {
          const accepted = await clickAcceptOnCard(card, inviteId);
          if (!accepted) {
            processedInviteIds.add(inviteId);
            continue;
          }
        }

        if (shouldAutoIntro) {
          const draft = await generateIntroDraftForInvite(recipientFirstName);
          if (!draft) {
            log('Generated empty intro draft; skipping invite', inviteId);
            processedInviteIds.add(inviteId);
            continue;
          }

          const openResult = await openMessageComposerFromCard(card, recipientFirstName, inviteId, draft);
          if (openResult === 'failed') {
            processedInviteIds.add(inviteId);
            continue;
          }

          if (openResult === 'navigating') {
            processedInviteIds.add(inviteId);
            return;
          }

          const inserted = insertDraftIntoComposer(draft);
          if (!inserted) {
            log('Failed to insert intro draft into composer', inviteId);
            processedInviteIds.add(inviteId);
            continue;
          }

          await wait(300);
          const sent = clickSendButton();
          if (!sent) {
            log('Intro inserted but send button not found; manual send may be required', inviteId);
          }
        }

        processedInviteIds.add(inviteId);
      } catch (err) {
        logError('Auto-accept invite processing error:', { inviteId, error: err?.message || String(err) });
      }

      await wait(randomInt(800, 1500));
    }
  } catch (err) {
    logError('Auto-accept batch failed:', err);
  } finally {
    isAutoAcceptRunning = false;
  }
}

/* ============================================================
   Calendar Scheduling Watcher
   ============================================================ */

function isMessagingContextForScheduler() {
  const path = (window.location.pathname || '').toLowerCase();
  if (path.startsWith('/messaging')) return true;
  return !!document.querySelector('.msg-overlay-conversation-bubble, .msg-convo-wrapper');
}

function hasOpenMessagingComposerForScheduler() {
  const selectors = [
    '.msg-overlay-conversation-bubble form.msg-form',
    '.msg-convo-wrapper form.msg-form',
    '.msg-thread form.msg-form',
    '.msg-form__contenteditable',
  ];
  return selectors.some((sel) => {
    try {
      const el = document.querySelector(sel);
      return !!(el && (el.offsetParent || el.getClientRects().length));
    } catch (_err) {
      return false;
    }
  });
}

function getLastIncomingMessage(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]?.role === 'them') return conversation[i];
  }
  return null;
}

function getLatestMessage(conversation) {
  if (!Array.isArray(conversation) || conversation.length === 0) return null;
  return conversation[conversation.length - 1] || null;
}

function getMessageHash(conversation, lastIncoming) {
  const text = String(lastIncoming?.text || '').trim().toLowerCase();
  const incomingCount = conversation.reduce((count, msg) => (
    msg?.role === 'them' ? count + 1 : count
  ), 0);
  return `${incomingCount}:${text}`;
}

function hasMeetingLinkInText(text) {
  const value = String(text || '');
  if (!value) return false;
  const meetingLinkRegex = /(https?:\/\/\S*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|calendar\.google\.com)\S*)/i;
  return meetingLinkRegex.test(value);
}

function conversationHasMeetingLink(conversation) {
  if (!Array.isArray(conversation) || conversation.length === 0) return false;
  return conversation.some((msg) => hasMeetingLinkInText(msg?.text));
}

async function getScheduleStateMap() {
  return (await storageGet('local', SCHED_STATE_STORAGE_KEY)) || {};
}

async function saveScheduleStateMap(stateMap) {
  await storageSet('local', { [SCHED_STATE_STORAGE_KEY]: stateMap });
}

function buildProposalMessage(slots) {
  const slotA = slots[0];
  const slotB = slots[1];
  if (slotA && slotB) {
    return `I can do ${slotA.label} or ${slotB.label}. Would either work for you?`;
  }
  if (slotA) {
    return `I can do ${slotA.label}. Would that work for you?`;
  }
  return `I couldn't find an open slot in the next two weeks during work hours. Could you suggest a preferred day and time?`;
}

function buildManualHandoffMessage() {
  return `I think this needs a quick manual pick from my side. Share your preferred time and I will confirm shortly.`;
}

function buildEventConfirmationMessage(slot, event) {
  const slotLabel = slot?.label || 'the agreed time';
  const meetPart = event?.meetLink ? ` Google Meet: ${event.meetLink}` : '';
  return `Great, confirmed for ${slotLabel}. I just created the calendar invite.${meetPart}`;
}

function looksLikeMeetingRequest(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  return /(schedule|meeting|call|zoom|google meet|meet|available|availability|book time|find a time)/i.test(value);
}

function looksLikeSpecificTimeSuggestion(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  const hasTimePhrase = /\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|next week|this week|\d{1,2}(:\d{2})?\s?(am|pm))\b/i.test(value);
  const hasSuggestPhrase = /\b(how about|what about|can we do|does .*work|would .*work|at)\b/i.test(value);
  return hasTimePhrase || (hasSuggestPhrase && /\d/.test(value));
}

function getMeetingOffsetFromIndex(rawIndex) {
  const index = Number(rawIndex);
  if (Number.isNaN(index) || index < 0 || index >= MEETING_OFFSET_OPTIONS.length) return MEETING_OFFSET_OPTIONS[0];
  return MEETING_OFFSET_OPTIONS[index];
}

function parseIso(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isNaN(ts) ? NaN : ts;
}

function getSlotAfterOffset(slots, minStartTs) {
  if (!Array.isArray(slots)) return null;
  return slots.find((slot) => {
    const startTs = parseIso(slot?.start);
    return Number.isFinite(startTs) && startTs >= minStartTs;
  }) || null;
}

async function resolveMeetingSlotForManualAssist(conversation, offsetMs) {
  const threadId = getThreadId();
  const stateMap = await getScheduleStateMap();
  const state = stateMap[threadId] || {
    phase: 'idle',
    proposedSlots: [],
    selectedSlot: null,
    turnCount: 0,
    lastMessageHash: '',
    eventId: '',
  };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const minStartTs = Date.now() + Number(offsetMs || 0);

  let selectedSlot = null;
  try {
    const decision = await callApi('/linkedin/schedule/decide', {
      conversation,
      threadState: state,
      timezone: timeZone,
    });
    if (decision?.selectedSlot?.start && decision?.selectedSlot?.end) {
      const suggestedTs = parseIso(decision.selectedSlot.start);
      if (Number.isFinite(suggestedTs) && suggestedTs >= minStartTs) {
        selectedSlot = decision.selectedSlot;
      }
    }
  } catch (_err) {
    // Fallback below if decision endpoint fails.
  }

  if (!selectedSlot && state?.selectedSlot?.start && state?.selectedSlot?.end) {
    const stateSlotTs = parseIso(state.selectedSlot.start);
    if (Number.isFinite(stateSlotTs) && stateSlotTs >= minStartTs) {
      selectedSlot = state.selectedSlot;
    }
  }

  if (!selectedSlot) {
    const availability = await callApi('/calendar/availability', {
      timeZone,
      lookaheadDays: 14,
      workStartHour: 9,
      workEndHour: 18,
      durationMinutes: 30,
      limit: 6,
    });
    const slots = Array.isArray(availability?.slots) ? availability.slots : [];
    selectedSlot = getSlotAfterOffset(slots, minStartTs);
  }

  if (!selectedSlot?.start || !selectedSlot?.end) return null;
  return {
    slot: selectedSlot,
    timeZone,
  };
}

async function getAlternativeSlotsForManualAssist(offsetMs) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const minStartTs = Date.now() + Number(offsetMs || 0);
  const availability = await callApi('/calendar/availability', {
    timeZone,
    lookaheadDays: 14,
    workStartHour: 9,
    workEndHour: 18,
    durationMinutes: 30,
    limit: 10,
  });
  const slots = Array.isArray(availability?.slots) ? availability.slots : [];
  const filtered = slots.filter((slot) => {
    const startTs = parseIso(slot?.start);
    return Number.isFinite(startTs) && startTs >= minStartTs;
  });
  return filtered.slice(0, 2);
}

async function autoSendMessageText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (!hasOpenMessagingComposerForScheduler()) {
    log('Scheduler send skipped: no open messaging composer.');
    return false;
  }

  const inserted = insertDraftIntoComposer(normalized);
  if (!inserted) return false;
  await wait(300);
  return clickSendButton();
}

async function runCalendarSchedulerTick(trigger = 'unknown') {
  if (isSchedulerTickRunning) return;
  if (!settings.enabled || !settings.calendarSchedulingEnabled) return;
  if (!settings.autoReplyContinuously) return;
  if (!isMessagingContextForScheduler()) return;
  if (!hasOpenMessagingComposerForScheduler()) return;

  isSchedulerTickRunning = true;
  try {
    const conversation = extractConversation();
    if (!Array.isArray(conversation) || conversation.length === 0) return;

    const latestMessage = getLatestMessage(conversation);
    if (!latestMessage || latestMessage.role !== 'them') return;

    const lastIncoming = getLastIncomingMessage(conversation);
    if (!lastIncoming) return;

    const threadId = getThreadId();
    const stateMap = await getScheduleStateMap();
    const state = stateMap[threadId] || {
      phase: 'idle',
      proposedSlots: [],
      selectedSlot: null,
      turnCount: 0,
      lastMessageHash: '',
      eventId: '',
    };

    const messageHash = getMessageHash(conversation, lastIncoming);
    if (state.lastMessageHash === messageHash) return;

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const decision = await callApi('/linkedin/schedule/decide', {
      conversation,
      threadState: state,
      timezone: timeZone,
    });

    const nextState = {
      ...state,
      lastMessageHash: messageHash,
      lastEvaluatedAt: Date.now(),
    };

    if (decision.action === 'no_action') {
      stateMap[threadId] = nextState;
      await saveScheduleStateMap(stateMap);
      return;
    }

    if (decision.action === 'manual_handoff') {
      const sent = await autoSendMessageText(buildManualHandoffMessage());
      if (!sent) return;
      stateMap[threadId] = {
        ...nextState,
        phase: 'manual_handoff',
      };
      await saveScheduleStateMap(stateMap);
      return;
    }

    if (decision.action === 'propose_slots' || decision.action === 'counter_propose') {
      const availability = await callApi('/calendar/availability', {
        timeZone,
        lookaheadDays: 14,
        workStartHour: 9,
        workEndHour: 18,
        durationMinutes: 30,
        limit: 2,
      });
      const slots = Array.isArray(availability?.slots) ? availability.slots : [];
      const sent = await autoSendMessageText(buildProposalMessage(slots));
      if (!sent) return;

      stateMap[threadId] = {
        ...nextState,
        phase: 'proposed',
        proposedSlots: slots,
        selectedSlot: slots[0] || null,
        turnCount: Number(nextState.turnCount || 0) + 1,
      };
      await saveScheduleStateMap(stateMap);
      return;
    }

    if (decision.action === 'confirm_create_event') {
      if (conversationHasMeetingLink(conversation)) {
        stateMap[threadId] = {
          ...nextState,
          phase: 'confirmed',
        };
        await saveScheduleStateMap(stateMap);
        return;
      }

      const selectedSlot =
        decision.selectedSlot ||
        nextState.selectedSlot ||
        (Array.isArray(nextState.proposedSlots) ? nextState.proposedSlots[0] : null);
      if (!selectedSlot?.start || !selectedSlot?.end) {
        stateMap[threadId] = {
          ...nextState,
          phase: 'manual_handoff',
        };
        await saveScheduleStateMap(stateMap);
        return;
      }

      const createRes = await callApi('/calendar/events', {
        startIso: selectedSlot.start,
        endIso: selectedSlot.end,
        timeZone,
        title: 'LinkedIn Meeting',
        description: `Auto-created from LinkedIn scheduling flow (trigger: ${trigger}).`,
      });

      const event = createRes?.event || {};
      const sent = await autoSendMessageText(buildEventConfirmationMessage(selectedSlot, event));
      if (!sent) return;

      stateMap[threadId] = {
        ...nextState,
        phase: 'confirmed',
        eventId: event.id || '',
        selectedSlot,
        turnCount: Number(nextState.turnCount || 0) + 1,
      };
      await saveScheduleStateMap(stateMap);
      return;
    }
  } catch (err) {
    logError('Calendar scheduler tick failed:', err?.message || err);
  } finally {
    isSchedulerTickRunning = false;
  }
}

function startCalendarScheduler() {
  if (schedulerIntervalId) return;
  schedulerIntervalId = setInterval(() => {
    runCalendarSchedulerTick('interval');
  }, SCHEDULER_INTERVAL_MS);
}

/* ============================================================
   UI Panel Management
   ============================================================ */

let currentPanel = null;

/**
 * Creates and shows the draft panel near the composer.
 * @param {HTMLElement} anchorContainer
 */
function showPanel(anchorContainer) {
  // Remove any existing panel
  hidePanel();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'qwen-panel';

  panel.innerHTML = `
    <div class="qwen-panel-header">
      <h4>Auto-generate Reply</h4>
      <button class="qwen-panel-close" title="Close">&times;</button>
    </div>
    <div class="qwen-panel-body">
      <div class="qwen-tone-row">
        <label>Tone:</label>
        <select class="qwen-tone-select" id="qwen-tone-select">
          <option value="professional">Professional</option>
          <option value="friendly">Friendly</option>
          <option value="concise">Concise</option>
        </select>
      </div>
      <button class="qwen-btn qwen-btn-primary" id="qwen-generate-draft">
        Generate Draft
      </button>
      <div class="qwen-meeting-assist hidden" id="qwen-meeting-assist">
        <label class="qwen-meeting-assist-toggle">
          <input type="checkbox" id="qwen-calendar-assist-toggle" />
          Use Google Calendar assist for scheduling
        </label>
        <div class="qwen-meeting-offset">
          <label for="qwen-calendar-offset">Earliest meeting time:</label>
          <input type="range" id="qwen-calendar-offset" min="0" max="${MEETING_OFFSET_OPTIONS.length - 1}" step="1" value="0" />
          <div class="qwen-meeting-offset-label" id="qwen-calendar-offset-label">${MEETING_OFFSET_OPTIONS[0].label}</div>
        </div>
        <div class="qwen-meeting-confirm hidden" id="qwen-meeting-confirm">
          <div class="qwen-meeting-confirm-text">Would you like to create a meeting link for this?</div>
          <div class="qwen-meeting-confirm-actions">
            <button class="qwen-btn qwen-btn-success" id="qwen-meeting-yes" type="button">Yes</button>
            <button class="qwen-btn qwen-btn-secondary" id="qwen-meeting-no" type="button">No</button>
          </div>
        </div>
      </div>
      <div class="qwen-template-options hidden" id="qwen-template-options">
        <div class="qwen-template-options-title">No messages yet. Pick a starter:</div>
        <button class="qwen-btn qwen-btn-secondary qwen-template-btn" id="qwen-template-connected" type="button">
          Connected with you
        </button>
        <button class="qwen-btn qwen-btn-secondary qwen-template-btn" id="qwen-template-intro" type="button">
          Self Introduction
        </button>
      </div>
      <textarea class="qwen-draft-area" id="qwen-draft-textarea"
        placeholder="Generated draft will appear here. You can edit it before inserting."
        rows="4"></textarea>
      <div class="qwen-actions">
        <button class="qwen-btn qwen-btn-primary" id="qwen-insert-btn" disabled>Insert into Composer</button>
        ${settings.showApproveSend
          ? '<button class="qwen-btn qwen-btn-success" id="qwen-approve-send-btn" disabled>Approve &amp; Send</button>'
          : ''}
      </div>
      <div class="qwen-status" id="qwen-status"></div>
    </div>
  `;

  // Position relative to anchor
  anchorContainer.style.position = 'relative';
  anchorContainer.appendChild(panel);
  currentPanel = panel;

  // Set the tone select to the saved default
  const toneSelect = panel.querySelector('#qwen-tone-select');
  toneSelect.value = settings.tone || 'professional';

  // Wire up event handlers
  wireUpPanelEvents(panel);

  log('Panel shown');
}

function hidePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    existing.remove();
  }
  currentPanel = null;
}

/**
 * Wires up click handlers for the panel.
 * @param {HTMLElement} panel
 */
function wireUpPanelEvents(panel) {
  // Close button
  panel.querySelector('.qwen-panel-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hidePanel();
  });

  const statusEl = panel.querySelector('#qwen-status');
  const draftArea = panel.querySelector('#qwen-draft-textarea');
  const generateBtn = panel.querySelector('#qwen-generate-draft');
  const insertBtn = panel.querySelector('#qwen-insert-btn');
  const approveSendBtn = panel.querySelector('#qwen-approve-send-btn');
  const templateOptions = panel.querySelector('#qwen-template-options');
  const templateConnectedBtn = panel.querySelector('#qwen-template-connected');
  const templateIntroBtn = panel.querySelector('#qwen-template-intro');
  const meetingAssist = panel.querySelector('#qwen-meeting-assist');
  const meetingAssistToggle = panel.querySelector('#qwen-calendar-assist-toggle');
  const meetingOffsetSlider = panel.querySelector('#qwen-calendar-offset');
  const meetingOffsetLabel = panel.querySelector('#qwen-calendar-offset-label');
  const meetingConfirm = panel.querySelector('#qwen-meeting-confirm');
  const meetingYesBtn = panel.querySelector('#qwen-meeting-yes');
  const meetingNoBtn = panel.querySelector('#qwen-meeting-no');
  let pendingMeetingContext = null;

  function setStatus(msg, type = 'info') {
    statusEl.textContent = msg;
    statusEl.className = `qwen-status ${type}`;
  }

  function setGeneratingState(isLoading, loadingText = 'Sending to Qwen...') {
    generateBtn.disabled = isLoading;
    generateBtn.innerHTML = isLoading
      ? '<span class="qwen-spinner"></span> Generating...'
      : 'Generate Draft';
    if (isLoading) {
      setStatus(loadingText, 'info');
      insertBtn.disabled = true;
      if (approveSendBtn) approveSendBtn.disabled = true;
    }
  }

  function showTemplateOptions(show) {
    if (!templateOptions) return;
    templateOptions.classList.toggle('hidden', !show);
  }

  function showMeetingAssist(show) {
    if (!meetingAssist) return;
    meetingAssist.classList.toggle('hidden', !show);
    if (!show && meetingConfirm) {
      meetingConfirm.classList.add('hidden');
      pendingMeetingContext = null;
    }
  }

  function setMeetingOffsetLabel() {
    if (!meetingOffsetSlider || !meetingOffsetLabel) return;
    const offset = getMeetingOffsetFromIndex(meetingOffsetSlider.value);
    meetingOffsetLabel.textContent = offset.label;
  }

  async function generateMeetingAssistDraft(context, mode = 'direct') {
    const offset = getMeetingOffsetFromIndex(meetingOffsetSlider?.value || 0);
    const offsetMs = offset.ms;
    setGeneratingState(true, 'Checking Google Calendar...');
    draftArea.value = '';
    showTemplateOptions(false);

    try {
      if (mode === 'counter') {
        const slots = await getAlternativeSlotsForManualAssist(offsetMs);
        if (!slots.length) {
          setStatus('No suitable slots found in your selected range. Try widening the range.', 'error');
          return;
        }
        draftArea.value = buildProposalMessage(slots);
      } else {
        const resolved = await resolveMeetingSlotForManualAssist(context.conversation, offsetMs);
        if (!resolved?.slot) {
          setStatus('Could not find a suitable slot. Try another range or suggest alternatives.', 'error');
          return;
        }
        const createRes = await callApi('/calendar/events', {
          startIso: resolved.slot.start,
          endIso: resolved.slot.end,
          timeZone: resolved.timeZone,
          title: 'LinkedIn Meeting',
          description: 'Scheduled from manual meeting-assist flow.',
        });
        const event = createRes?.event || {};
        draftArea.value = buildEventConfirmationMessage(resolved.slot, event);
      }

      insertBtn.disabled = false;
      if (approveSendBtn) approveSendBtn.disabled = false;
      if (meetingConfirm) meetingConfirm.classList.add('hidden');
      pendingMeetingContext = null;
      setStatus('Draft generated! Edit if needed, then click Insert.', 'success');
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      logError('Meeting assist generation failed:', err);
    } finally {
      setGeneratingState(false);
    }
  }

  async function generateStarterFromTemplate(templateType) {
    const tone = panel.querySelector('#qwen-tone-select').value;
    const recipientFirstName = await resolveSenderFirstName([]);

    // Use prompt-based enrichment flow (no silent detection from non-messaging contexts).
    if (needsSenderProfileEnrichment()) {
      await maybePromptToSaveProfile();
    }
    let senderFirstName = (settings.senderFirstName || '').trim();
    let senderHeadline = (settings.senderHeadline || '').trim();

    setGeneratingState(true, 'Generating starter message...');
    draftArea.value = '';
    showTemplateOptions(false);

    try {
      const draft = await callBackend({
        conversation: [],
        tone,
        recipientFirstName,
        senderFirstName,
        senderHeadline,
        starterTemplate: templateType,
        model: 'qwen-plus',
        redact: false,
      });

      draftArea.value = applyRecipientNameFallback(draft, recipientFirstName);
      insertBtn.disabled = false;
      if (approveSendBtn) approveSendBtn.disabled = false;
      setStatus('Draft generated! Edit if needed, then click Insert.', 'success');
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      logError('Template generation failed:', err);
    } finally {
      setGeneratingState(false);
    }
  }

  // Enable insert button when draft area has text
  draftArea.addEventListener('input', () => {
    const hasText = draftArea.value.trim().length > 0;
    insertBtn.disabled = !hasText;
    if (approveSendBtn) approveSendBtn.disabled = !hasText;
  });

  // Generate Draft
  generateBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Extract conversation
    const conversation = extractConversation();
    if (conversation.length === 0) {
      showMeetingAssist(false);
      showTemplateOptions(true);
      setStatus('No messages found in this thread. Choose a starter option.', 'info');
      return;
    }
    showTemplateOptions(false);
    const lastIncoming = getLastIncomingMessage(conversation);
    const incomingHasSpecificTime = !!lastIncoming && looksLikeSpecificTimeSuggestion(lastIncoming.text);
    const canUseMeetingAssist = !!lastIncoming && (
      incomingHasSpecificTime || looksLikeMeetingRequest(lastIncoming.text)
    );
    showMeetingAssist(canUseMeetingAssist);

    const tone = panel.querySelector('#qwen-tone-select').value;
    const shouldUseMeetingAssist = !!(canUseMeetingAssist && (incomingHasSpecificTime || meetingAssistToggle?.checked));
    if (shouldUseMeetingAssist) {
      const recipientFirstName = await resolveSenderFirstName(conversation);
      pendingMeetingContext = { conversation, tone, recipientFirstName };
      if (incomingHasSpecificTime) {
        if (meetingAssistToggle) meetingAssistToggle.checked = true;
        if (meetingConfirm) meetingConfirm.classList.remove('hidden');
        setStatus('They suggested a time. Would you like to create a meeting link for this?', 'info');
        return;
      }
      await generateMeetingAssistDraft(pendingMeetingContext, 'direct');
      return;
    }
    if (meetingConfirm) meetingConfirm.classList.add('hidden');
    pendingMeetingContext = null;

    setGeneratingState(true);
    draftArea.value = '';

    try {
      const recipientFirstName = await resolveSenderFirstName(conversation);
      const draft = await callBackend({
        conversation,
        tone,
        recipientFirstName,
        model: 'qwen-plus',
        redact: false,
      });

      draftArea.value = applyRecipientNameFallback(draft, recipientFirstName);
      insertBtn.disabled = false;
      if (approveSendBtn) approveSendBtn.disabled = false;
      setStatus('Draft generated! Edit if needed, then click Insert.', 'success');
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      logError('Generation failed:', err);
    } finally {
      setGeneratingState(false);
    }
  });

  if (templateConnectedBtn) {
    templateConnectedBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await generateStarterFromTemplate('connected_with_you');
    });
  }

  if (templateIntroBtn) {
    templateIntroBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await generateStarterFromTemplate('self_introduction');
    });
  }

  if (meetingOffsetSlider) {
    meetingOffsetSlider.addEventListener('input', setMeetingOffsetLabel);
    setMeetingOffsetLabel();
  }

  if (meetingYesBtn) {
    meetingYesBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!pendingMeetingContext) return;
      await generateMeetingAssistDraft(pendingMeetingContext, 'direct');
    });
  }

  if (meetingNoBtn) {
    meetingNoBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!pendingMeetingContext) return;
      if (meetingConfirm) meetingConfirm.classList.add('hidden');
      pendingMeetingContext = null;
      setStatus('Meeting link creation skipped. You can generate a normal draft now.', 'info');
    });
  }

  // Insert into Composer
  insertBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();

    const text = draftArea.value.trim();
    if (!text) {
      setStatus('Draft is empty.', 'error');
      return;
    }

    const ok = insertDraftIntoComposer(text);
    if (ok) {
      setStatus('Draft inserted into composer. Review and send when ready.', 'success');
      hidePanel();
    } else {
      setStatus('Could not find composer to insert into.', 'error');
    }
  });

  // Approve & Send
  if (approveSendBtn) {
    approveSendBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      const text = draftArea.value.trim();
      if (!text) {
        setStatus('Draft is empty.', 'error');
        return;
      }

      const inserted = insertDraftIntoComposer(text);
      if (!inserted) {
        setStatus('Could not find composer to insert into.', 'error');
        return;
      }

      // Small delay to let LinkedIn register the text, then click send
      setTimeout(() => {
        const sent = clickSendButton();
        if (sent) {
          setStatus('Message sent!', 'success');
          hidePanel();
        } else {
          setStatus('Draft inserted but Send button not found. Please send manually.', 'error');
        }
      }, 300);
    });
  }

  // Prevent clicks inside panel from propagating to LinkedIn
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.addEventListener('keydown', (e) => e.stopPropagation());
  panel.addEventListener('keyup', (e) => e.stopPropagation());
  panel.addEventListener('keypress', (e) => e.stopPropagation());
}

/* ============================================================
   UI Injection
   ============================================================ */

/**
 * Injects the "Auto-generate (Qwen)" button adjacent to the composer.
 */
function injectButton() {
  if (!settings.enabled) {
    log('Extension disabled, skipping injection');
    return;
  }

  // Already injected?
  if (document.getElementById(INJECTION_ID)) {
    log('Button already injected');
    return;
  }

  const composer = findComposer();
  if (!composer) return;

  const formContainer = findComposerFormContainer(composer);
  if (!formContainer) return;

  // Create the button container
  const container = document.createElement('div');
  container.id = INJECTION_ID;
  container.className = 'qwen-btn-container';

  const btn = document.createElement('button');
  btn.className = 'qwen-generate-btn';
  btn.type = 'button';
  btn.innerHTML = '<span class="qwen-icon">*</span> Auto-generate (Qwen)';
  btn.title = 'Generate a reply using Qwen AI';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (currentPanel) {
      hidePanel();
    } else {
      showPanel(formContainer);
    }
  });

  container.appendChild(btn);

  // Insert the container before the form / above the composer
  try {
    formContainer.insertBefore(container, formContainer.firstChild);
  } catch (e) {
    // Fallback: append before composer's parent
    formContainer.prepend(container);
  }

  log('Button injected successfully');
}

/* ============================================================
   Feature: Contact Finder
   ============================================================ */

function isPeopleSearchPage() {
  const path = (window.location.pathname || '').toLowerCase();
  return path.startsWith('/search/results/people/');
}

function stripLinkedInProfileUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (!/^\/in\//i.test(parsed.pathname)) return '';
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/`;
  } catch (_err) {
    return '';
  }
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function buildSearchKeywords(rolePrompt, locationPrompt) {
  const role = normalizeWhitespace(rolePrompt);
  const location = normalizeWhitespace(locationPrompt);
  return [role, location].filter(Boolean).join(' ');
}

function buildPeopleSearchUrl(rolePrompt, locationPrompt) {
  const keywords = buildSearchKeywords(rolePrompt, locationPrompt);
  if (!keywords) return '';
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set('keywords', keywords);
  url.searchParams.set('origin', 'SWITCH_SEARCH_VERTICAL');
  return url.toString();
}

function extractCandidateLocationText(card) {
  if (!card) return '';
  const selectors = [
    '.entity-result__secondary-subtitle',
    '.entity-result__primary-subtitle',
    '.t-14.t-normal',
    '[class*="entity-result__summary"]',
  ];
  for (const sel of selectors) {
    const el = card.querySelector(sel);
    const text = normalizeWhitespace(el?.textContent || '');
    if (text) return text;
  }
  return '';
}

function extractCandidateHeadlineText(card, profileName = '') {
  if (!card) return '';
  const primaryAnchor = extractPrimaryProfileAnchorFromCard(card);
  const anchorContainer = primaryAnchor?.closest('div, p');
  const scopedParagraphs = anchorContainer
    ? Array.from(anchorContainer.parentElement?.querySelectorAll('p') || [])
    : [];

  for (const el of scopedParagraphs) {
    const text = normalizeWhitespace(el.textContent || '');
    if (
      text &&
      text !== profileName &&
      !/followers?|current:|skills:|connect|follow|message/i.test(text) &&
      !text.includes(',')
    ) {
      return text;
    }
  }

  const selectors = [
    '[data-view-name="search-entity-result-primary-subtitle"]',
    '.entity-result__primary-subtitle',
    '[class*="primary-subtitle"]',
    'p',
  ];
  for (const sel of selectors) {
    const elements = Array.from(card.querySelectorAll(sel));
    for (const el of elements) {
      const text = normalizeWhitespace(el?.textContent || '');
      if (
        text &&
        text !== profileName &&
        !/followers?|current:|skills:|connect|follow|message/i.test(text) &&
        !text.includes(',')
      ) {
        return text;
      }
    }
  }

  const lines = (card.innerText || card.textContent || '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const filteredLines = lines.filter((line) => (
    line !== profileName &&
    !/^\d+(st|nd|rd|th)$/i.test(line) &&
    !/followers?|current:|skills:|connect|follow|message|reactivate premium|cancel anytime/i.test(line) &&
    !line.includes(',')
  ));

  return filteredLines[1] || filteredLines[0] || '';
}

function findSearchResultCard(anchor) {
  if (!anchor) return null;
  const selectors = [
    '[role="listitem"]',
    '[data-view-name="search-entity-result-universal-template"]',
    '.reusable-search__result-container',
    'li.reusable-search__result-container',
    'li.artdeco-list__item',
    'div[data-chameleon-result-urn]',
  ];
  for (const sel of selectors) {
    const card = anchor.closest(sel);
    if (card) return card;
  }
  return anchor.closest('li') || anchor.parentElement;
}

function cardHasProspectAction(card) {
  if (!card) return false;
  const actionTexts = Array.from(card.querySelectorAll('button, a[role="button"]'))
    .map((el) => normalizeWhitespace(el.textContent || ''))
    .filter(Boolean);
  return actionTexts.some((text) => /^(connect|follow|message)$/i.test(text));
}

function extractAnchorDisplayName(anchor) {
  if (!anchor) return '';
  const directText = normalizeWhitespace(anchor.innerText || anchor.textContent || '');
  if (directText) return directText;

  const labelled =
    normalizeWhitespace(anchor.getAttribute('aria-label') || '') ||
    normalizeWhitespace(anchor.getAttribute('title') || '');
  if (labelled) return labelled;

  const nestedText = normalizeWhitespace(
    anchor.querySelector('[aria-hidden="true"], span, div')?.textContent || ''
  );
  return nestedText;
}

function isBlockedPeopleAnchor(anchor) {
  if (!anchor) return true;
  const blockedParents = [
    'header',
    'nav',
    'footer',
    '.global-nav',
    '.search-global-typeahead',
    '.pv-top-card-profile-picture',
    '.global-nav__me',
  ];
  if (blockedParents.some((sel) => anchor.closest(sel))) return true;

  const href = anchor.getAttribute('href') || '';
  if (!/\/in\//i.test(href)) return true;
  if (/\/overlay\/|\/detail\/|\/details\/|\/recent-activity\//i.test(href)) return true;
  return false;
}

function collectCandidatePeopleAnchors() {
  const directSelectors = [
    'a[data-view-name="search-result-lockup-title"][href*="/in/"]',
    'a[href*="/in/"][data-view-name*="search-result-lockup"]',
    'a[href*="/in/"][data-view-name*="search-result"]',
  ];
  const seenUrls = new Set();
  const results = [];

  for (const sel of directSelectors) {
    const anchors = Array.from(document.querySelectorAll(sel));
    for (const anchor of anchors) {
      if (isBlockedPeopleAnchor(anchor)) continue;

      const profileUrl = stripLinkedInProfileUrl(anchor.href);
      if (!profileUrl || seenUrls.has(profileUrl)) continue;

      const name = extractAnchorDisplayName(anchor);
      if (!name || name.length < 3) continue;

      seenUrls.add(profileUrl);
      results.push(anchor);
    }
    if (results.length > 0) return results;
  }

  const containers = Array.from(document.querySelectorAll(
    'main, .search-results-container, .reusable-search__entity-result-list, ul[role="list"]'
  ));
  const roots = containers.length > 0 ? containers : [document.body];
  for (const root of roots) {
    const anchors = Array.from(root.querySelectorAll('a[href*="/in/"]'));
    for (const anchor of anchors) {
      if (isBlockedPeopleAnchor(anchor)) continue;

      const profileUrl = stripLinkedInProfileUrl(anchor.href);
      if (!profileUrl || seenUrls.has(profileUrl)) continue;

      const name = extractAnchorDisplayName(anchor);
      if (!name || name.length < 3) continue;

      seenUrls.add(profileUrl);
      results.push(anchor);
    }
  }

  return results;
}

function extractPrimaryProfileAnchorFromCard(card) {
  if (!card) return null;
  const prioritySelectors = [
    'a[data-view-name="search-result-lockup-title"][href*="/in/"]',
    'a[href*="/in/"][data-view-name*="search-result"]',
  ];

  for (const sel of prioritySelectors) {
    const anchor = card.querySelector(sel);
    if (anchor && !isBlockedPeopleAnchor(anchor)) return anchor;
  }

  const anchors = Array.from(card.querySelectorAll('a[href*="/in/"]'));
  for (const anchor of anchors) {
    if (isBlockedPeopleAnchor(anchor)) continue;
    const name = extractAnchorDisplayName(anchor);
    if (!name || name.length < 3) continue;
    return anchor;
  }

  return null;
}

function collectProfilesFromHtmlFallback(locationFilter = '') {
  const lowerLocationFilter = normalizeWhitespace(locationFilter).toLowerCase();
  const html = document.body?.innerHTML || '';
  const results = [];
  const seen = new Set();
  const regex = /<a[^>]+href="([^"]*\/in\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const profileUrl = stripLinkedInProfileUrl(match[1]);
    if (!profileUrl || seen.has(profileUrl)) continue;

    const rawName = normalizeWhitespace(match[2].replace(/<[^>]+>/g, ' '));
    if (!rawName || rawName.length < 3) continue;
    if (/contact info|message|connect/i.test(rawName)) continue;

    if (lowerLocationFilter) {
      const nearby = html.slice(Math.max(0, match.index - 600), Math.min(html.length, match.index + 1200)).toLowerCase();
      if (!nearby.includes(lowerLocationFilter)) continue;
    }

    seen.add(profileUrl);
    results.push({
      name: rawName,
      profileUrl,
      location: 'Unknown',
      headline: '',
    });
  }

  return results;
}

function collectPeopleSearchProfiles(locationFilter = '') {
  const lowerLocationFilter = normalizeWhitespace(locationFilter).toLowerCase();
  const anchors = collectCandidatePeopleAnchors();
  const seen = new Set();
  const profiles = [];

  for (const anchor of anchors) {
    const profileUrl = stripLinkedInProfileUrl(anchor.href);
    if (!profileUrl || seen.has(profileUrl)) continue;

    const card = findSearchResultCard(anchor);
    if (!card) continue;
    if (!cardHasProspectAction(card)) continue;

    const cardText = normalizeWhitespace(card.textContent || '');
    if (!cardText) continue;

    const locationText = extractCandidateLocationText(card);
    if (lowerLocationFilter && !locationText.toLowerCase().includes(lowerLocationFilter)) {
      continue;
    }

    const name = normalizeWhitespace(anchor.textContent || '') || profileUrl;
    profiles.push({
      name,
      profileUrl,
      location: locationText || 'Unknown',
    });
    seen.add(profileUrl);
  }

  if (profiles.length > 0) return profiles;
  return collectProfilesFromHtmlFallback(lowerLocationFilter);
}

function extractUniqueMatches(text, pattern, normalizer) {
  const matches = text.match(pattern) || [];
  const set = new Set();
  for (const match of matches) {
    const normalized = normalizer(match);
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

function extractContactInfoFromHtml(html, sourceUrl) {
  const plainText = normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  const emails = extractUniqueMatches(
    plainText,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    (v) => v.toLowerCase()
  );

  const phones = extractUniqueMatches(
    plainText,
    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g,
    (v) => normalizeWhitespace(v).replace(/[^\d+]/g, '')
  ).filter((v) => v.replace(/\D/g, '').length >= 7);

  const urls = extractUniqueMatches(
    html,
    /https?:\/\/[^\s"'<>]+/gi,
    (v) => v.replace(/[),.;]+$/, '')
  ).filter((v) => !/\/(jobs|feed|search)\//i.test(v));

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const hrefs = Array.from(doc.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .map((href) => {
        try {
          return new URL(href, sourceUrl).toString();
        } catch (_err) {
          return '';
        }
      })
      .filter(Boolean);
    for (const href of hrefs) {
      if (/^mailto:/i.test(href)) {
        const email = href.replace(/^mailto:/i, '').trim().toLowerCase();
        if (email) emails.push(email);
      } else if (/^tel:/i.test(href)) {
        const phone = href.replace(/^tel:/i, '').trim().replace(/[^\d+]/g, '');
        if (phone) phones.push(phone);
      } else if (/^https?:/i.test(href) && !/linkedin\.com\/(feed|search|jobs)\//i.test(href)) {
        urls.push(href);
      }
    }
  } catch (_err) {
    // DOM parsing best effort only.
  }

  return {
    emails: Array.from(new Set(emails)),
    phones: Array.from(new Set(phones)),
    links: Array.from(new Set(urls)),
  };
}

async function fetchProfileContactInfo(profileUrl) {
  const trimmedProfileUrl = stripLinkedInProfileUrl(profileUrl);
  if (!trimmedProfileUrl) {
    return { emails: [], phones: [], links: [], sourceUrl: '', status: 'invalid_profile_url' };
  }

  const noTrailingSlash = trimmedProfileUrl.replace(/\/+$/, '');
  const candidateUrls = [
    `${noTrailingSlash}/overlay/contact-info/`,
    `${noTrailingSlash}/details/contact-info/`,
    `${noTrailingSlash}/detail/contact-info/`,
    trimmedProfileUrl,
  ];

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const extracted = extractContactInfoFromHtml(html, url);
      const hasData = extracted.emails.length || extracted.phones.length || extracted.links.length;
      if (hasData) {
        return { ...extracted, sourceUrl: url, status: 'ok' };
      }
    } catch (_err) {
      // Try next candidate.
    }
  }

  return { emails: [], phones: [], links: [], sourceUrl: '', status: 'no_contact_data' };
}

function formatFetchedContacts(results) {
  const rows = [];
  for (const item of results) {
    rows.push(`${item.index}. ${item.name}`);
    rows.push(`Profile: ${item.profileUrl}`);
    rows.push(`Search location: ${item.location}`);
    if (item.contact?.sourceUrl) rows.push(`Source: ${item.contact.sourceUrl}`);
    rows.push(`Emails: ${(item.contact?.emails || []).join(', ') || 'None found'}`);
    rows.push(`Phones: ${(item.contact?.phones || []).join(', ') || 'None found'}`);
    rows.push(`Links: ${(item.contact?.links || []).join(', ') || 'None found'}`);
    rows.push('');
  }
  return rows.join('\n').trim();
}

function handleContactFinderRuntimeMessage(message, sendResponse) {
  if (message?.type !== 'qwen_people_search_tool') return false;

  (async () => {
    try {
      if (message.command === 'open') {
        const result = await openPeopleSearchToolFromPopup();
        sendResponse({ ok: true, ...result });
        return;
      }
      if (message.command === 'close') {
        const result = closePeopleSearchToolFromPopup();
        sendResponse({ ok: true, ...result });
        return;
      }
      if (message.command === 'get_state') {
        sendResponse({
          ok: true,
          isOpen: !!document.getElementById(SEARCH_TOOL_ID),
          isPeopleSearchPage: isPeopleSearchPage(),
          manuallyClosed: peopleSearchToolManuallyClosed,
        });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown command' });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
}

function registerContactFinderMessageHandlers() {
  if (contactFinderMessageHandlersRegistered) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => (
    handleContactFinderRuntimeMessage(message, sendResponse)
  ));
  contactFinderMessageHandlersRegistered = true;
}

/* ============================================================
   Contact Finder Helpers
   ============================================================ */

async function savePeopleSearchInputs(roleInput, locationInput) {
  await storageSet('local', {
    qwen_people_search_inputs: {
      role: normalizeWhitespace(roleInput),
      location: normalizeWhitespace(locationInput),
      updatedAt: Date.now(),
    },
  });
}

async function loadPeopleSearchInputs() {
  const saved = await storageGet('local', 'qwen_people_search_inputs');
  return {
    role: normalizeWhitespace(saved?.role || ''),
    location: normalizeWhitespace(saved?.location || ''),
  };
}

function renderSearchToolMarkup() {
  return `
    <div class="qwen-search-tool-header">
      <strong>People Contact Finder</strong>
      <button type="button" class="qwen-search-tool-minimize" id="qwen-search-tool-minimize" title="Collapse panel">-</button>
    </div>
    <div class="qwen-search-tool-body" id="qwen-search-tool-body">
      <label for="qwen-search-role">Role prompt</label>
      <input id="qwen-search-role" type="text" placeholder="e.g. data scientist" />
      <label for="qwen-search-location">Location filter</label>
      <input id="qwen-search-location" type="text" placeholder="e.g. Kuala Lumpur" />
      <div class="qwen-search-tool-actions">
        <button type="button" class="qwen-btn qwen-btn-primary" id="qwen-search-apply-btn">Apply Search</button>
        <button type="button" class="qwen-btn qwen-btn-secondary" id="qwen-search-fetch-btn">Count + Fetch</button>
      </div>
      <div class="qwen-status info" id="qwen-search-status">Ready.</div>
      <textarea id="qwen-search-results" class="qwen-search-results" placeholder="Fetched contact info will appear here." readonly></textarea>
    </div>
  `;
}

function removePeopleSearchTool() {
  const existing = document.getElementById(SEARCH_TOOL_ID);
  if (existing) existing.remove();
}

function setPeopleSearchToolCollapsed(collapsed) {
  const container = document.getElementById(SEARCH_TOOL_ID);
  if (!container) return;
  const body = container.querySelector('#qwen-search-tool-body');
  const minimizeBtn = container.querySelector('#qwen-search-tool-minimize');
  const shouldCollapse = !!collapsed;
  container.classList.toggle('collapsed', shouldCollapse);
  if (body) body.style.display = shouldCollapse ? 'none' : 'flex';
  if (minimizeBtn) {
    minimizeBtn.textContent = shouldCollapse ? '+' : '-';
    minimizeBtn.title = shouldCollapse ? 'Expand panel' : 'Collapse panel';
  }
}

async function injectPeopleSearchTool(forceOpen = false) {
  if (!settings.enabled || !isPeopleSearchPage()) {
    removePeopleSearchTool();
    return;
  }
  if (peopleSearchToolManuallyClosed && !forceOpen) return;

  if (document.getElementById(SEARCH_TOOL_ID)) {
    if (forceOpen) setPeopleSearchToolCollapsed(false);
    return;
  }

  const container = document.createElement('aside');
  container.id = SEARCH_TOOL_ID;
  container.className = 'qwen-search-tool';
  container.innerHTML = renderSearchToolMarkup();
  document.body.appendChild(container);

  const body = container.querySelector('#qwen-search-tool-body');
  const minimizeBtn = container.querySelector('#qwen-search-tool-minimize');
  const roleInput = container.querySelector('#qwen-search-role');
  const locationInput = container.querySelector('#qwen-search-location');
  const applyBtn = container.querySelector('#qwen-search-apply-btn');
  const fetchBtn = container.querySelector('#qwen-search-fetch-btn');
  const statusEl = container.querySelector('#qwen-search-status');
  const resultsArea = container.querySelector('#qwen-search-results');

  const setSearchStatus = (message, type = 'info') => {
    statusEl.className = `qwen-status ${type}`;
    statusEl.textContent = message;
  };

  const persistedInputs = await loadPeopleSearchInputs();
  roleInput.value = persistedInputs.role;
  locationInput.value = persistedInputs.location;

  minimizeBtn.addEventListener('click', () => {
    setPeopleSearchToolCollapsed(!container.classList.contains('collapsed'));
  });

  applyBtn.addEventListener('click', async () => {
    const rolePrompt = roleInput.value;
    const locationPrompt = locationInput.value;
    await savePeopleSearchInputs(rolePrompt, locationPrompt);

    const nextUrl = buildPeopleSearchUrl(rolePrompt, locationPrompt);
    if (!nextUrl) {
      setSearchStatus('Enter at least a role prompt.', 'error');
      return;
    }

    setSearchStatus('Opening LinkedIn people search...', 'info');
    window.location.href = nextUrl;
  });

  fetchBtn.addEventListener('click', async () => {
    if (isSearchContactFetchRunning) return;
    isSearchContactFetchRunning = true;
    fetchBtn.disabled = true;
    applyBtn.disabled = true;

    try {
      const rolePrompt = roleInput.value;
      const locationPrompt = locationInput.value;
      await savePeopleSearchInputs(rolePrompt, locationPrompt);

      const profiles = collectPeopleSearchProfiles(locationPrompt);
      const count = profiles.length;
      const confirmText = `${count} profiles found. Would you like to fetch their contact info?`;
      if (!window.confirm(confirmText)) {
        setSearchStatus('Fetch cancelled.', 'info');
        return;
      }

      if (!count) {
        setSearchStatus('No profiles matched the current filters.', 'error');
        return;
      }

      const results = [];
      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        setSearchStatus(`Fetching ${i + 1}/${profiles.length}: ${profile.name}`, 'info');
        const contact = await fetchProfileContactInfo(profile.profileUrl);
        results.push({
          index: i + 1,
          ...profile,
          contact,
        });
      }

      const summary = formatFetchedContacts(results);
      resultsArea.value = summary || 'No contact data found.';
      setSearchStatus(`Done. Processed ${results.length} profile(s).`, 'success');
    } catch (err) {
      setSearchStatus(`Contact fetch failed: ${err?.message || String(err)}`, 'error');
    } finally {
      fetchBtn.disabled = false;
      applyBtn.disabled = false;
      isSearchContactFetchRunning = false;
    }
  });

  log('People search tool injected');
}

async function openPeopleSearchToolFromPopup() {
  peopleSearchToolManuallyClosed = false;
  if (!isPeopleSearchPage()) {
    const saved = await loadPeopleSearchInputs();
    const nextUrl =
      buildPeopleSearchUrl(saved.role, saved.location) ||
      'https://www.linkedin.com/search/results/people/?origin=SWITCH_SEARCH_VERTICAL';
    window.location.href = nextUrl;
    return { ok: true, navigated: true };
  }
  await injectPeopleSearchTool(true);
  setPeopleSearchToolCollapsed(false);
  return { ok: true, navigated: false };
}

function closePeopleSearchToolFromPopup() {
  peopleSearchToolManuallyClosed = true;
  removePeopleSearchTool();
  return { ok: true };
}

function tryInjectAutoReplyFeature() {
  injectButton();
}

function tryInjectContactFinderFeature() {
  injectPeopleSearchTool();
}

/**
 * Removes all injected UI elements.
 */
function removeInjectedUI() {
  const container = document.getElementById(INJECTION_ID);
  if (container) container.remove();
  removePeopleSearchTool();
  hidePanel();
  log('Injected UI removed');
}

/* ============================================================
   MutationObserver - Re-inject on LinkedIn SPA Navigation
   ============================================================ */

let observerDebounceTimer = null;
let observerInitialized = false;

function tryInject() {
  if (!extensionContextActive || !isExtensionContextValid()) {
    disableExtensionRuntime('tryInject-invalid-context');
    return;
  }
  if (!settings.enabled) return;
  tryInjectAutoReplyFeature();
  tryInjectContactFinderFeature();
}

function setupObserver() {
  if (observerInitialized) return;
  if (!extensionContextActive || !isExtensionContextValid()) {
    disableExtensionRuntime('setupObserver-invalid-context');
    return;
  }
  observerInitialized = true;

  observerInstance = new MutationObserver(() => {
    if (!extensionContextActive || !isExtensionContextValid()) {
      disableExtensionRuntime('observer-invalid-context');
      return;
    }
    // Debounce to avoid excessive re-checks
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      if (!extensionContextActive || !isExtensionContextValid()) {
        disableExtensionRuntime('observer-debounce-invalid-context');
        return;
      }
      // Try to detect and persist sender profile early when DOM changes
      if (needsSenderProfileEnrichment()) {
        maybePromptToSaveProfile();
      }

      // Check if our injected UI still exists; if not, re-inject.
      const needsMessagingUi = findComposer() && !document.getElementById(INJECTION_ID);
      const needsSearchUi =
        isPeopleSearchPage() &&
        !peopleSearchToolManuallyClosed &&
        !document.getElementById(SEARCH_TOOL_ID);
      if (needsMessagingUi || needsSearchUi) {
        log('Injected UI missing, re-injecting...');
        tryInject();
      }

      processPendingAutoIntroOnMessagingPage();
      runAutoAcceptAndIntroBatch('observer');
      runCalendarSchedulerTick('observer');
    }, OBSERVER_DEBOUNCE_MS);
  });

  observerInstance.observe(document.body, {
    childList: true,
    subtree: true,
  });

  log('MutationObserver active');
}

/* ============================================================
   Initialization
   ============================================================ */

async function init() {
  log('Initializing LinkedIn Auto-Reply (Qwen)...');
  if (!isExtensionContextValid()) {
    disableExtensionRuntime('init-invalid-context');
    return;
  }

  await loadSettings();
  registerContactFinderMessageHandlers();

  if (!settings.enabled) {
    log('Extension is disabled');
    return;
  }

  processPendingAutoIntroOnMessagingPage();
  startCalendarScheduler();
  runCalendarSchedulerTick('init');

  // Start observing early so we can recover/inject as the DOM changes
  setupObserver();

  // Initial attempt to detect and persist sender profile on first load
  if (needsSenderProfileEnrichment()) {
    maybePromptToSaveProfile();
  }

  // Initial injection attempt with retries
  let injected = false;
  for (let i = 0; i < 10; i++) {
    tryInject();
    if (document.getElementById(INJECTION_ID) || document.getElementById(SEARCH_TOOL_ID)) {
      injected = true;
      break;
    }
    // Wait and retry (LinkedIn may still be loading)
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!injected) {
    log('Could not inject on initial load; observer will keep trying');
  }

  runAutoAcceptAndIntroBatch('init');

  // Observer already initialized above.
}

// Start
init();

