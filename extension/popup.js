/**
 * popup.js — Settings popup for LinkedIn Auto-Reply (Qwen)
 * Reads / writes settings to chrome.storage.sync.
 */

const DEFAULTS = {
  enabled: true,
  tone: 'professional',
  maxTurns: 12,
  showApproveSend: false,
};

const $ = (id) => document.getElementById(id);

// Load saved settings into the form
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    $('enabled').checked = settings.enabled;
    $('tone').value = settings.tone;
    $('maxTurns').value = settings.maxTurns;
    $('showApproveSend').checked = settings.showApproveSend;
  });
}

// Save settings from the form
function saveSettings() {
  const settings = {
    enabled: $('enabled').checked,
    tone: $('tone').value,
    maxTurns: parseInt($('maxTurns').value, 10) || 12,
    showApproveSend: $('showApproveSend').checked,
  };

  // Clamp maxTurns
  settings.maxTurns = Math.max(1, Math.min(50, settings.maxTurns));

  chrome.storage.sync.set(settings, () => {
    $('status').textContent = '✓ Settings saved';
    setTimeout(() => {
      $('status').textContent = '';
    }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', loadSettings);
$('saveBtn').addEventListener('click', saveSettings);
