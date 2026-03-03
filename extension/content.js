/**
 * content.js — LinkedIn Auto-Reply (Qwen) Content Script
 *
 * Injects a "Auto-generate (Qwen)" button into the LinkedIn Messaging composer.
 * Extracts conversation history, calls local backend, and inserts the draft.
 */

/* ============================================================
   Configuration & Constants
   ============================================================ */

const DEBUG = false; // Set to true for verbose console logging
const BACKEND_URL = 'http://localhost:3000/linkedin/draft';
const INJECTION_ID = 'qwen-autoreply-container';
const PANEL_ID = 'qwen-autoreply-panel';
const MAX_MSG_LENGTH = 1000; // Truncate individual messages
const RETRY_MAX = 3; // Exponential backoff retries for backend calls
const OBSERVER_DEBOUNCE_MS = 500;

// Default settings (overridden by chrome.storage.sync)
let settings = {
  enabled: true,
  tone: 'professional',
  maxTurns: 12,
  showApproveSend: false,
};

function log(...args) {
  if (DEBUG) console.log('[Qwen AutoReply]', ...args);
}

function logError(...args) {
  console.error('[Qwen AutoReply]', ...args);
}

/* ============================================================
   Settings Loader
   ============================================================ */

function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(settings, (stored) => {
        settings = { ...settings, ...stored };
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
    }
    // Re-evaluate injection
    if ('enabled' in changes) {
      if (settings.enabled) {
        tryInject();
      } else {
        removeInjectedUI();
      }
    }
  });
}

/* ============================================================
   Composer Detection — Multiple Selector Fallbacks
   ============================================================ */

/**
 * Attempts to find the LinkedIn messaging composer textbox.
 * Uses multiple selectors with fallbacks for robustness.
 * @returns {HTMLElement|null}
 */
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
      const el = document.querySelector(sel);
      if (el) {
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
  const maxTurns = settings.maxTurns || 12;

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
      text = text.substring(0, MAX_MSG_LENGTH) + '…';
    }

    // Determine role: "me" vs "them"
    const role = classifyMessageRole(node);

    conversation.push({ role, text });
  }

  log('Extracted conversation:', conversation);
  return conversation;
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
      if (/^you$/i.test(senderText)) return 'me';
      if (senderText.length > 0) return 'them';
    }
  }

  // Signal 3: Check aria-label / accessibility attributes
  const ariaLabel = node.getAttribute('aria-label') || '';
  if (/\byou\b/i.test(ariaLabel) && /\bsent\b/i.test(ariaLabel)) return 'me';

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

    // Find the inner paragraph if any
    let target = composer.querySelector('p');
    if (!target) target = composer;

    // Set the text
    target.innerText = text;

    // Dispatch input event so LinkedIn picks up the change
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
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
      <h4>✨ Auto-generate Reply</h4>
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

  function setStatus(msg, type = 'info') {
    statusEl.textContent = msg;
    statusEl.className = `qwen-status ${type}`;
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
      setStatus('No messages found in this thread. Open a conversation first.', 'error');
      return;
    }

    const tone = panel.querySelector('#qwen-tone-select').value;

    generateBtn.disabled = true;
    generateBtn.innerHTML = '<span class="qwen-spinner"></span> Generating…';
    setStatus('Sending to Qwen…', 'info');
    draftArea.value = '';
    insertBtn.disabled = true;
    if (approveSendBtn) approveSendBtn.disabled = true;

    try {
      const draft = await callBackend({
        conversation,
        tone,
        model: 'qwen-plus',
        redact: false,
      });

      draftArea.value = draft;
      insertBtn.disabled = false;
      if (approveSendBtn) approveSendBtn.disabled = false;
      setStatus('Draft generated! Edit if needed, then click Insert.', 'success');
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      logError('Generation failed:', err);
    } finally {
      generateBtn.disabled = false;
      generateBtn.innerHTML = 'Generate Draft';
    }
  });

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
  btn.innerHTML = '<span class="qwen-icon">✨</span> Auto-generate (Qwen)';
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

/**
 * Removes all injected UI elements.
 */
function removeInjectedUI() {
  const container = document.getElementById(INJECTION_ID);
  if (container) container.remove();
  hidePanel();
  log('Injected UI removed');
}

/* ============================================================
   MutationObserver — Re-inject on LinkedIn SPA Navigation
   ============================================================ */

let observerDebounceTimer = null;

function tryInject() {
  if (!settings.enabled) return;
  injectButton();
}

function setupObserver() {
  const observer = new MutationObserver(() => {
    // Debounce to avoid excessive re-checks
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      // Check if our button still exists; if not, re-inject
      if (!document.getElementById(INJECTION_ID)) {
        log('Button missing, re-injecting...');
        tryInject();
      }
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
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

  await loadSettings();

  if (!settings.enabled) {
    log('Extension is disabled');
    return;
  }

  // Initial injection attempt with retries
  let injected = false;
  for (let i = 0; i < 10; i++) {
    injectButton();
    if (document.getElementById(INJECTION_ID)) {
      injected = true;
      break;
    }
    // Wait and retry (LinkedIn may still be loading)
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!injected) {
    log('Could not inject on initial load; observer will keep trying');
  }

  // Watch for DOM changes (SPA navigation, thread switches)
  setupObserver();
}

// Start
init();
