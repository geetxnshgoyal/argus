import qrcode from 'qrcode-generator';
import { syncClock } from '../lib/clock.ts';
import { b64urlEncode, epochAt, importRoundKey, qrContent, qrTag } from './qr.ts';
import './display.css';

/**
 * Classroom display (spec §6, protocol §5.2–§5.3, ADR-0004). A separate,
 * framework-free bundle with no student data.
 *
 * Pairing: this page makes a random secret in memory, registers only its
 * hash, and shows a short code. The teacher links the code from their own
 * signed-in Argus page; the display then fetches the current round's QR key
 * with its secret. Opened as /display?session=<id> from the teacher's own
 * laptop, it uses the teacher's sign-in instead (no code).
 *
 * The round key lives only in a non-extractable WebCrypto key in memory:
 * never in localStorage, wiped when the session ends. QR codes keep rotating
 * offline because they are computed from the server-synced clock.
 */

type Active = {
  status: 'active';
  session_id: string;
  round: number;
  mode: 'full' | 'targeted' | 'end';
  t0_ms: number;
  epoch_ms: number;
  k_qr: string;
  server_time_ms: number;
  label: string;
  ends_at: string;
};
type State = Active | { status: 'waiting'; code: string; expires_at: string; server_time_ms: number } | { status: 'ended' } | { status: 'expired' };

const AUTO_END_GRACE_MS = 15 * 60_000;

const root = document.getElementById('display') as HTMLElement;
root.innerHTML = `
  <section id="pair" hidden>
    <p class="eyebrow">Argus · Classroom screen</p>
    <h1>Connect this screen</h1>
    <p class="lead">Teacher: in Argus, open your class and choose <strong>Connect classroom screen</strong>, then enter this code. Or scan the code with your phone camera.</p>
    <div class="pair-row">
      <div class="code" id="pair-code" aria-label="Pairing code"></div>
      <canvas id="pair-qr" width="220" height="220" aria-label="Pairing QR code"></canvas>
    </div>
    <p class="muted" id="pair-expiry"></p>
  </section>
  <section id="active" hidden>
    <div class="active-head">
      <span class="label" id="label"></span>
      <span class="round" id="round"></span>
    </div>
    <canvas id="qr" aria-label="Attendance QR code. Scan it with the Argus app."></canvas>
    <div class="active-foot">
      <svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="15.9"/><circle id="ring" class="ring-fg" cx="18" cy="18" r="15.9" stroke-dasharray="100 100"/></svg>
      <span>Open the Argus app and tap <strong>Scan</strong></span>
    </div>
  </section>
  <section id="message" hidden>
    <h1 id="message-title"></h1>
    <p class="lead" id="message-text"></p>
  </section>
  <div id="offline" class="offline" hidden>No connection: the code still works, keep scanning.</div>
  <button id="fullscreen" class="fs-btn" type="button">Full screen</button>
`;
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

let offsetMs = 0;
let active: Active | null = null;
let roundKey: CryptoKey | null = null;
let lastEpoch = -1;
let pairing: { id: string; secret: string } | null = null;
let pollTimer: number | undefined;
let wakeLock: WakeLockSentinel | null = null;
const directSession = new URLSearchParams(location.search).get('session');

const serverNow = () => Date.now() + offsetMs;

function show(id: 'pair' | 'active' | 'message') {
  for (const s of ['pair', 'active', 'message']) $(s).hidden = s !== id;
  document.body.dataset.screen = id;
}

function message(title: string, text: string) {
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  show('message');
}

function drawQr(canvas: HTMLCanvasElement, text: string, sizePx: number) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.max(1, Math.floor(sizePx / (n + quiet * 2)));
  const dim = cell * (n + quiet * 2);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = dim * dpr;
  canvas.height = dim * dpr;
  canvas.style.width = `${dim}px`;
  canvas.style.height = `${dim}px`;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  // Always black on white for scan reliability (ADR-0018).
  g.fillStyle = '#fff';
  g.fillRect(0, 0, dim, dim);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
}

function wipe() {
  roundKey = null;
  active = null;
  lastEpoch = -1;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    // Not supported or refused: the teacher can keep the screen on manually.
  }
}

// ── Pairing ─────────────────────────────────────────────────────────────────

async function sha256b64url(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function post<T>(url: string, body: unknown): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  let json: T | null = null;
  try {
    json = (await res.json()) as T;
  } catch {
    // no body
  }
  return { status: res.status, body: json };
}

async function newPairing() {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = b64urlEncode(secretBytes);
  const res = await post<{ pairing_id: string; code: string; expires_at: string }>('/v1/display/pairings', { secret_hash: await sha256b64url(secretBytes) });
  secretBytes.fill(0);
  if (res.status !== 201 || !res.body) throw new Error('pairing failed');
  pairing = { id: res.body.pairing_id, secret };
  showPairing(res.body.code, res.body.expires_at);
}

function showPairing(code: string, expiresAt: string) {
  $('pair-code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  drawQr($<HTMLCanvasElement>('pair-qr'), `${location.origin}/teacher/pair?code=${code}`, 220);
  $('pair-expiry').textContent = `Code valid until ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. A new one appears automatically.`;
  show('pair');
}

async function fetchState(): Promise<State | null> {
  try {
    if (directSession) {
      const res = await fetch(`/v1/attendance/sessions/${encodeURIComponent(directSession)}/display`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (res.status === 401 || res.status === 404) return { status: 'ended' };
      return res.ok ? ((await res.json()) as State) : null;
    }
    if (!pairing) return null;
    const res = await post<State>(`/v1/display/pairings/${pairing.id}/state`, { secret: pairing.secret });
    if (res.status === 403) return { status: 'expired' };
    return res.body;
  } catch {
    return null; // offline
  }
}

async function poll() {
  const state = await fetchState();
  $('offline').hidden = state !== null || !active;
  if (state) await apply(state);
  const delay = active ? 4000 : 2000;
  pollTimer = window.setTimeout(() => void poll(), delay);
}

async function apply(state: State) {
  switch (state.status) {
    case 'waiting':
      if (!active) show('pair');
      return;
    case 'expired':
      wipe();
      if (!directSession) await newPairing();
      return;
    case 'ended':
      if (active || directSession) {
        wipe();
        message('Attendance ended', directSession ? 'You can close this window.' : 'This screen will be ready for the next class in a moment.');
        if (!directSession) {
          pairing = null;
          window.setTimeout(() => void newPairing().catch(() => undefined), 8000);
        }
      }
      return;
    case 'active': {
      // Refine the clock offset from each response (the round trip is small next to 3 s epochs).
      if (!active) offsetMs = state.server_time_ms - Date.now();
      if (!active || active.round !== state.round || active.session_id !== state.session_id) {
        roundKey = await importRoundKey(state.k_qr);
        lastEpoch = -1;
      }
      active = { ...state, k_qr: '' }; // keep only the non-extractable CryptoKey
      $('label').textContent = state.label;
      $('round').textContent = state.round === 1 ? 'Attendance' : `Recheck · round ${state.round}`;
      show('active');
      void requestWakeLock();
      return;
    }
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

async function frame() {
  if (active && roundKey) {
    const now = serverNow();
    if (now > Date.parse(active.ends_at) + AUTO_END_GRACE_MS) {
      wipe();
      message('Class time is over', 'Attendance has closed for this class.');
    } else {
      const e = epochAt(now, active.t0_ms, active.epoch_ms);
      if (e !== lastEpoch) {
        lastEpoch = e;
        const tag = await qrTag(roundKey, active.session_id, active.round, e);
        const size = Math.min(window.innerWidth * 0.9, window.innerHeight - 190);
        drawQr($<HTMLCanvasElement>('qr'), qrContent(active.session_id, active.round, e, tag), size);
      }
      const left = 1 - ((now - active.t0_ms) % active.epoch_ms) / active.epoch_ms;
      $('ring').setAttribute('stroke-dasharray', `${Math.round(left * 100)} 100`);
    }
  }
  requestAnimationFrame(() => void frame());
}

$('fullscreen').addEventListener('click', () => {
  void document.documentElement.requestFullscreen?.().catch(() => undefined);
});
document.addEventListener('visibilitychange', () => void requestWakeLock());
window.addEventListener('resize', () => (lastEpoch = -1));
window.addEventListener('pagehide', () => {
  wipe();
  pairing = null;
  if (pollTimer) clearTimeout(pollTimer);
});

async function start() {
  message('Connecting…', 'Contacting the Argus server.');
  try {
    offsetMs = (await syncClock()).offsetMs;
  } catch {
    message('Cannot reach Argus', 'Check this computer’s network connection. Retrying…');
    window.setTimeout(() => void start(), 5000);
    return;
  }
  if (!directSession) await newPairing();
  void poll();
  void frame();
}

void start();
