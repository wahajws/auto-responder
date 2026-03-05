/**
 * popup.js — Settings popup for LinkedIn Auto-Reply (Qwen)
 * Reads / writes settings to chrome.storage.sync.
 */

const DEFAULTS = {
  enabled: true,
  tone: 'professional',
  maxTurns: '10',
  showApproveSend: false,
  senderFirstName: '',
  senderHeadline: '',
};

const $ = (id) => document.getElementById(id);
const ALLOWED_MAX_TURNS = new Set(['most-recent', '5', '10', 'all']);

function normalizeMaxTurns(value) {
  if (ALLOWED_MAX_TURNS.has(String(value))) return String(value);

  // Backward compatibility for older numeric settings.
  const numeric = parseInt(value, 10);
  if (!Number.isNaN(numeric)) {
    if (numeric <= 1) return 'most-recent';
    if (numeric <= 5) return '5';
    if (numeric <= 10) return '10';
    return 'all';
  }

  return DEFAULTS.maxTurns;
}

// Load saved settings into the form
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    $('enabled').checked = settings.enabled;
    $('tone').value = settings.tone;
    $('maxTurns').value = normalizeMaxTurns(settings.maxTurns);
    $('showApproveSend').checked = settings.showApproveSend;
    $('senderFirstName').value = settings.senderFirstName || '';
    $('senderHeadline').value = settings.senderHeadline || '';
  });
}

// Save settings from the form
function saveSettings() {
  const settings = {
    enabled: $('enabled').checked,
    tone: $('tone').value,
    maxTurns: normalizeMaxTurns($('maxTurns').value),
    showApproveSend: $('showApproveSend').checked,
    senderFirstName: $('senderFirstName').value.trim(),
    senderHeadline: $('senderHeadline').value.trim(),
  };

  chrome.storage.sync.set(settings, () => {
    $('status').textContent = '✓ Settings saved';
    setTimeout(() => {
      $('status').textContent = '';
    }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', loadSettings);
$('saveBtn').addEventListener('click', saveSettings);
