// Phone remote page. Connects to the Volume Wizard extension running in
// Chrome on the computer, over an encrypted WebRTC data channel set up through
// the PeerJS broker, and shows the same controls as the popup's tab list.
//
// The pairing comes from the QR code link: "#p=<peer id>&k=<key>". The part
// after "#" is never sent to the server hosting this page.
//
// Published from the extension's repository (remote/), together with
// ./lib/volume-curve.js, ./icons.js and ./vendor/peerjs.min.js (global Peer).

import {
  DEFAULT_VOLUME,
  clampVolume,
  positionToVolume,
  volumeToPosition,
  roundVolume,
} from './lib/volume-curve.js';
import { ICON, svgIcon } from './icons.js';

const SLIDER_MAX = 1000;
const SNAP_TO_DEFAULT = 4; // % around 100 that snaps to exactly 100 while dragging
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const REQUEST_TIMEOUT_MS = 10000;
const REFRESH_DELAY_MS = 120;
const STORAGE_KEY = 'volume-wizard-pairing';
const HINT = 'Open Volume Wizard on this tab on your computer once to unlock its slider.';

const $ = (id) => document.getElementById(id);
const els = {
  connection: $('connection'),
  message: $('message'),
  messageText: $('message-text'),
  retry: $('retry'),
  content: $('content'),
  solo: $('solo'),
  tabs: $('tabs'),
  empty: $('empty'),
};

// ---------- pairing ----------

// From the link, remembered so the page keeps working without it.
function readPairing() {
  const params = new URLSearchParams(location.hash.slice(1));
  const peerId = params.get('p');
  const key = params.get('k');
  if (peerId && key) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ peerId, key }));
    } catch {
      // Private browsing: works for this visit only.
    }
    return { peerId, key };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.peerId && saved?.key) return saved;
  } catch {
    // Nothing saved.
  }
  return null;
}

// ---------- status ----------

function setConnection(state, text) {
  els.connection.dataset.state = state;
  els.connection.textContent = text;
}

function showMessage(text, { retry = false } = {}) {
  els.messageText.textContent = text;
  els.retry.hidden = !retry;
  els.message.hidden = false;
  els.content.hidden = true;
}

function showContent() {
  els.message.hidden = true;
  els.content.hidden = false;
}

// ---------- connection ----------

let pairing = null;
let peer = null;
let conn = null;
let accepted = false;
let denied = false;
let attempt = 0;
let reconnectTimer = null;
let nextRequestId = 1;
const pending = new Map(); // request id → { resolve, reject, timer }

function failPending(reason) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  pending.clear();
}

function scheduleReconnect() {
  if (denied) return;
  clearTimeout(reconnectTimer);
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  attempt += 1;
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(reconnectTimer);
  if (denied) return;
  setConnection('connecting', 'Connecting…');
  if (!peer || peer.destroyed) {
    peer = new Peer({ debug: 0 });
    peer.on('open', openConnection);
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('error', (error) => {
      if (error.type === 'peer-unavailable') {
        setConnection('error', 'Computer offline');
        if (!accepted) {
          showMessage(
            "Can't reach your computer. Check that Chrome is open there and that Phone remote is on in Volume Wizard's settings.",
            { retry: true },
          );
        }
      } else {
        setConnection('error', 'Connection problem');
      }
      scheduleReconnect();
    });
  } else if (peer.open) {
    openConnection();
  } else if (peer.disconnected) {
    peer.reconnect();
  }
}

function openConnection() {
  conn?.close();
  const current = peer.connect(pairing.peerId, { reliable: true });
  conn = current;

  current.on('open', () => current.send({ type: 'hello', key: pairing.key }));
  current.on('data', (message) => {
    if (current !== conn) return;
    handleMessage(message);
  });
  const closed = () => {
    if (current !== conn) return;
    accepted = false;
    failPending('Disconnected');
    if (!denied) {
      setConnection('connecting', 'Reconnecting…');
      scheduleReconnect();
    }
  };
  current.on('close', closed);
  current.on('error', closed);
}

function handleMessage(message) {
  if (message?.type === 'welcome') {
    accepted = true;
    attempt = 0;
    setConnection('connected', 'Connected');
    refresh();
    return;
  }
  if (message?.type === 'denied') {
    denied = true;
    setConnection('error', 'Not paired');
    showMessage('This link is no longer valid. Scan the QR code in Volume Wizard’s settings again.');
    return;
  }
  if (message?.type === 'changed') {
    scheduleRefresh();
    return;
  }
  const request = pending.get(message?.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.ok) request.resolve(message.result);
  else request.reject(new Error(message.error || 'Command failed'));
}

function request(type, params = {}) {
  return new Promise((resolve, reject) => {
    if (!accepted || !conn?.open) {
      reject(new Error('Not connected'));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('No answer from your computer'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    conn.send({ id, type, ...params });
  });
}

// A phone asleep loses the connection; reconnect as soon as it's back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !accepted && !denied && pairing) {
    attempt = 0;
    connect();
  }
});

els.retry.addEventListener('click', () => {
  attempt = 0;
  connect();
});

// ---------- tab list ----------

const rows = new Map(); // tabId → row state
let soloActive = false;
let refreshTimer = null;

function isSafeIconUrl(url) {
  return /^(https?:|data:image\/)/.test(url ?? '');
}

function element(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

// One request in flight per tab; while busy only the latest is kept.
function createSender(row) {
  let busy = false;
  let next = null;
  return function send(command) {
    if (busy) {
      next = command;
      return;
    }
    busy = true;
    request(command.type, { tabId: row.tab.id, volume: command.volume })
      .then((result) => {
        row.captured = result.captured;
        row.error = '';
      })
      .catch((error) => {
        if (/activeTab|not been invoked|permission/i.test(error.message)) {
          row.controllable = false;
          row.volume = DEFAULT_VOLUME;
        } else {
          row.error = error.message;
        }
      })
      .finally(() => {
        busy = false;
        renderRow(row);
        if (next) {
          const queued = next;
          next = null;
          send(queued);
        }
      });
  };
}

function createRow(tab) {
  const row = { tab, volume: tab.volume, captured: tab.captured, controllable: tab.controllable, dragging: false, error: '' };

  const li = element('li', 'tab');
  const head = element('div', 'tab-head');
  const favicon = element('img', 'favicon', { alt: '', width: '18', height: '18' });
  const fallback = element('span', 'favicon favicon-fallback');
  fallback.innerHTML = svgIcon(ICON.sound, 16);
  favicon.addEventListener('error', () => {
    favicon.hidden = true;
    fallback.hidden = false;
  });
  const title = element('span', 'title');
  const chip = element('span', 'chip');
  chip.textContent = 'On screen';
  const mute = element('button', 'icon-button mute', { type: 'button' });
  head.append(favicon, fallback, title, chip, mute);

  const controls = element('div', 'controls');
  const slider = element('input', 'slider', { type: 'range', min: '0', max: String(SLIDER_MAX), step: '1' });
  const value = element('span', 'value');
  const reset = element('button', 'icon-button', { type: 'button', 'aria-label': 'Reset to default' });
  reset.innerHTML = svgIcon(ICON.reset, 20);
  controls.append(slider, value, reset);

  const hint = element('p', 'hint');
  hint.textContent = HINT;
  const error = element('p', 'error', { role: 'status' });

  li.append(head, controls, hint, error);
  Object.assign(row, { el: li, favicon, fallback, title, chip, mute, controls, slider, value, reset, hint, errorEl: error });
  row.send = createSender(row);

  const setMute = (muted) => {
    if (row.tab.muted === muted) return;
    row.tab.muted = muted;
    renderRow(row);
    request('set-muted', { tabId: row.tab.id, muted }).catch((err) => {
      row.tab.muted = !muted;
      row.error = err.message;
      renderRow(row);
    });
  };
  mute.addEventListener('click', () => setMute(!row.tab.muted));

  slider.addEventListener('input', () => {
    let volume = positionToVolume(Number(slider.value) / SLIDER_MAX);
    if (Math.abs(volume - DEFAULT_VOLUME) < SNAP_TO_DEFAULT) volume = DEFAULT_VOLUME;
    row.volume = volume;
    setMute(false); // changing the volume unmutes, as in the popup
    renderRow(row, { fromSlider: true });
    row.send({ type: 'set-volume', volume });
  });
  slider.addEventListener('pointerdown', () => {
    row.dragging = true;
    window.addEventListener('pointerup', () => (row.dragging = false), { once: true });
    window.addEventListener('pointercancel', () => (row.dragging = false), { once: true });
  });

  reset.addEventListener('click', () => {
    row.volume = DEFAULT_VOLUME;
    setMute(false);
    renderRow(row);
    row.send({ type: 'reset' });
  });

  return row;
}

function renderRow(row, { fromSlider = false } = {}) {
  const { tab } = row;
  row.title.textContent = tab.title;
  row.chip.hidden = !tab.current;
  row.el.classList.toggle('on-screen', Boolean(tab.current));

  const icon = isSafeIconUrl(tab.favIconUrl) ? tab.favIconUrl : '';
  if (icon && row.favicon.getAttribute('src') !== icon) {
    row.favicon.hidden = false;
    row.fallback.hidden = true;
    row.favicon.src = icon;
  } else if (!icon) {
    row.favicon.hidden = true;
    row.fallback.hidden = false;
  }

  row.mute.innerHTML = svgIcon(tab.muted ? ICON.muted : ICON.sound, 22);
  row.mute.setAttribute('aria-pressed', String(tab.muted));
  row.mute.setAttribute('aria-label', tab.muted ? 'Unmute tab' : 'Mute tab');
  row.el.classList.toggle('muted', tab.muted);

  const rounded = roundVolume(row.volume);
  row.controls.hidden = !row.controllable;
  row.hint.hidden = row.controllable;
  if (!fromSlider) row.slider.value = String(Math.round(volumeToPosition(clampVolume(row.volume)) * SLIDER_MAX));
  row.slider.style.setProperty('--fill', `${(Number(row.slider.value) / SLIDER_MAX) * 100}%`);
  row.slider.setAttribute('aria-label', `Volume of ${tab.title}`);
  row.slider.setAttribute('aria-valuetext', `${rounded}%`);
  row.value.textContent = `${rounded}%`;
  row.el.classList.toggle('boosted', rounded > DEFAULT_VOLUME);
  row.reset.hidden = !row.captured;

  row.errorEl.textContent = row.error;
  row.errorEl.hidden = !row.error;
}

function renderSolo(tabs) {
  els.solo.setAttribute('aria-pressed', String(soloActive));
  const onScreen = tabs.find((tab) => tab.current);
  const othersPlaying = tabs.some((tab) => !tab.current && !tab.muted && (tab.audible || tab.captured));
  els.solo.disabled = !soloActive && !othersPlaying && !onScreen?.muted;
}

async function refresh() {
  let data;
  try {
    data = await request('list');
  } catch {
    return; // The connection handling shows the problem.
  }
  showContent();
  soloActive = data.soloActive;

  const seen = new Set();
  data.tabs.forEach((tab, index) => {
    seen.add(tab.id);
    let row = rows.get(tab.id);
    if (row) {
      row.tab = tab;
      if (!row.dragging) {
        row.volume = tab.volume;
        row.captured = tab.captured;
        row.controllable = tab.controllable;
      }
    } else {
      row = createRow(tab);
      rows.set(tab.id, row);
    }
    renderRow(row);
    if (els.tabs.children[index] !== row.el) els.tabs.insertBefore(row.el, els.tabs.children[index] ?? null);
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }
  els.empty.hidden = rows.size > 0;
  renderSolo(data.tabs);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
}

els.solo.addEventListener('click', async () => {
  els.solo.disabled = true;
  try {
    ({ active: soloActive } = await request('solo-toggle'));
  } catch {
    // Shown by the refresh below.
  }
  refresh();
});

// ---------- start ----------

pairing = readPairing();
if (!pairing) {
  setConnection('error', 'Not paired');
  showMessage(
    'To pair this phone, open Volume Wizard on your computer, go to Settings, turn on Phone remote and scan the QR code.',
  );
} else {
  showMessage('Connecting to your computer…');
  connect();
}
