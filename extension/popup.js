/**
 * popup.js — Settings popup for LinkedIn Auto-Reply (Qwen)
 * Reads / writes settings to chrome.storage.sync.
 */

const DEFAULTS = {
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

const $ = (id) => document.getElementById(id);
const ALLOWED_MAX_TURNS = new Set(['most-recent', '5', '10', 'all']);
const BACKEND_BASE_URL = 'http://localhost:3000';
const SETTINGS_OPEN_CLASS = 'settings-open';

function setStatusMessage(message, timeoutMs = 2000) {
  const statusEl = $('status');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  if (!message || timeoutMs <= 0) return;
  setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = '';
  }, timeoutMs);
}

function setPeopleFinderButtonState({ isOpen = false, disabled = false } = {}) {
  const btn = $('togglePeopleFinderBtn');
  if (!btn) return;
  btn.textContent = isOpen ? 'Close Contact Finder' : 'Open Contact Finder';
  btn.disabled = !!disabled;
}

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

function sendPeopleFinderCommand(command) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        reject(new Error('No active tab found.'));
        return;
      }

      const url = String(tab.url || '');
      if (!/^https:\/\/www\.linkedin\.com\//i.test(url)) {
        reject(new Error('Open a LinkedIn tab first.'));
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        { type: 'qwen_people_search_tool', command },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error('LinkedIn tab is not ready. Refresh and try again.'));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'Command failed.'));
            return;
          }
          resolve(response);
        }
      );
    });
  });
}

async function openPeopleFinder() {
  try {
    const response = await sendPeopleFinderCommand('open');
    setPeopleFinderButtonState({ isOpen: true });
    setStatusMessage(
      response?.navigated
        ? 'Opening LinkedIn people search...'
        : 'People Contact Finder opened.',
      2200
    );
  } catch (err) {
    setStatusMessage(err?.message || 'Could not open Contact Finder.', 2600);
  }
}

async function closePeopleFinder() {
  try {
    await sendPeopleFinderCommand('close');
    setPeopleFinderButtonState({ isOpen: false });
    setStatusMessage('People Contact Finder closed.', 2200);
  } catch (err) {
    setStatusMessage(err?.message || 'Could not close Contact Finder.', 2600);
  }
}

async function refreshPeopleFinderButtonState() {
  setPeopleFinderButtonState({ isOpen: false, disabled: true });
  try {
    const response = await sendPeopleFinderCommand('get_state');
    setPeopleFinderButtonState({ isOpen: !!response?.isOpen, disabled: false });
  } catch (_err) {
    // Keep the button usable so it can still open the finder on a LinkedIn tab.
    setPeopleFinderButtonState({ isOpen: false, disabled: false });
  }
}

async function togglePeopleFinder() {
  const btn = $('togglePeopleFinderBtn');
  if (!btn) return;
  const wantsClose = btn.textContent.trim() === 'Close Contact Finder';
  if (wantsClose) {
    await closePeopleFinder();
  } else {
    await openPeopleFinder();
  }
}

function setSettingsPanelOpen(open) {
  document.body.classList.toggle(SETTINGS_OPEN_CLASS, !!open);
}

function toggleSettingsPanel() {
  const isOpen = document.body.classList.contains(SETTINGS_OPEN_CLASS);
  setSettingsPanelOpen(!isOpen);
}

// Load saved settings into the form
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (settings) => {
    const useLegacyCombinedToggle =
      settings.autoAcceptMyNetworkIntro && !settings.autoAcceptMyNetwork && !settings.autoIntroMyNetwork;

    $('enabled').checked = settings.enabled;
    $('tone').value = settings.tone;
    $('maxTurns').value = normalizeMaxTurns(settings.maxTurns);
    $('showApproveSend').checked = settings.showApproveSend;
    $('autoAcceptMyNetwork').checked = useLegacyCombinedToggle
      ? true
      : settings.autoAcceptMyNetwork;
    $('autoIntroMyNetwork').checked = useLegacyCombinedToggle
      ? true
      : settings.autoIntroMyNetwork;
    $('calendarSchedulingEnabled').checked = !!settings.calendarSchedulingEnabled;
    $('autoReplyContinuously').checked = !!settings.autoReplyContinuously;
    $('senderFirstName').value = settings.senderFirstName || '';
    $('senderHeadline').value = settings.senderHeadline || '';
    setSettingsPanelOpen(false);
    refreshCalendarStatus();
    refreshPeopleFinderButtonState();
  });
}

async function fetchCalendarStatus() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/google/auth/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (_err) {
    return { connected: false, configured: false, error: true };
  }
}

async function refreshCalendarStatus() {
  const status = await fetchCalendarStatus();
  const textEl = $('calendarStatusText');
  if (!textEl) return;

  if (status.error) {
    textEl.textContent = 'Server unreachable (start backend first).';
    return;
  }
  if (!status.configured) {
    textEl.textContent = 'Google OAuth not configured on server.';
  } else {
    textEl.textContent = status.connected
      ? 'Connected'
      : 'Not connected';
  }

  chrome.storage.sync.set({
    calendarConnected: !!status.connected,
  });
}

function connectCalendar() {
  window.open(`${BACKEND_BASE_URL}/google/auth/start`, '_blank');
  setTimeout(refreshCalendarStatus, 1500);
}

async function disconnectCalendar() {
  try {
    await fetch(`${BACKEND_BASE_URL}/google/auth/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_err) {
    // Ignore request errors; status refresh below will reflect state.
  }
  await refreshCalendarStatus();
}

// Save settings from the form
function saveSettings() {
  const autoAcceptMyNetwork = $('autoAcceptMyNetwork').checked;
  const autoIntroMyNetworkRequested = $('autoIntroMyNetwork').checked;
  const autoIntroMyNetwork = autoAcceptMyNetwork && autoIntroMyNetworkRequested;

  const settings = {
    enabled: $('enabled').checked,
    tone: $('tone').value,
    maxTurns: normalizeMaxTurns($('maxTurns').value),
    showApproveSend: $('showApproveSend').checked,
    autoAcceptMyNetwork,
    autoIntroMyNetwork,
    autoAcceptMyNetworkIntro: false,
    calendarSchedulingEnabled: $('calendarSchedulingEnabled').checked,
    autoReplyContinuously: $('autoReplyContinuously').checked,
    senderFirstName: $('senderFirstName').value.trim(),
    senderHeadline: $('senderHeadline').value.trim(),
  };

  chrome.storage.sync.set(settings, () => {
    if (settings.enabled) setSettingsPanelOpen(false);
    setStatusMessage(autoIntroMyNetworkRequested && !autoAcceptMyNetwork
      ? 'Auto-intro requires Auto-accept. Saved with intro off.'
      : 'Settings saved');
  });
}
document.addEventListener('DOMContentLoaded', loadSettings);
$('saveBtn').addEventListener('click', saveSettings);
if ($('settingsToggleBtn')) $('settingsToggleBtn').addEventListener('click', toggleSettingsPanel);
if ($('enabled')) {
  $('enabled').addEventListener('change', (event) => {
    if (event.target.checked) setSettingsPanelOpen(true);
  });
}
if ($('togglePeopleFinderBtn')) $('togglePeopleFinderBtn').addEventListener('click', togglePeopleFinder);
if ($('connectCalendarBtn')) $('connectCalendarBtn').addEventListener('click', connectCalendar);
if ($('disconnectCalendarBtn')) $('disconnectCalendarBtn').addEventListener('click', disconnectCalendar);
