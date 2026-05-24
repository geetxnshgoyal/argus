import { syncClock } from '../lib/clock.ts';
import './display.css';

/**
 * Classroom display (separate, minimal bundle: no framework, no student data).
 * M0: shows the pairing placeholder and a server-synced clock to prove the
 * clock-sync path. Pairing and the rotating QR arrive in M4.
 */

const root = document.getElementById('display');
if (!root) throw new Error('#display missing');

root.innerHTML = `
  <h1>Argus</h1>
  <p class="status" id="status">Connecting…</p>
  <p class="clock" id="clock" aria-label="Server time"></p>
`;
const status = document.getElementById('status') as HTMLElement;
const clock = document.getElementById('clock') as HTMLElement;

let offsetMs = 0;

function tick() {
  clock.textContent = new Date(Date.now() + offsetMs).toLocaleTimeString();
}

async function start() {
  try {
    const sync = await syncClock();
    offsetMs = sync.offsetMs;
    status.textContent = 'Waiting for a teacher to pair this screen.';
  } catch {
    status.textContent = 'Cannot reach the Argus server. Check the network connection.';
  }
  tick();
  setInterval(tick, 1000);
}

void start();
