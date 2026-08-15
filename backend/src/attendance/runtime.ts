import { EventEmitter } from 'node:events';

/**
 * In-process runtime state for attendance (ADR-0003: one process, no Redis).
 *
 *  KeyCache    decrypted K_s per attendance session (ciphertext stays in the DB)
 *  LiveEvents  "something changed in session X" notifications for the teacher's
 *              live panel (Server-Sent Events). If Argus ever runs as several
 *              processes this becomes Postgres LISTEN/NOTIFY.
 */

export class KeyCache {
  private readonly map = new Map<string, Buffer>();
  private readonly max: number;

  constructor(max = 1000) {
    this.max = max;
  }

  get(sessionId: string): Buffer | undefined {
    const k = this.map.get(sessionId);
    if (k) {
      // Refresh LRU position.
      this.map.delete(sessionId);
      this.map.set(sessionId, k);
    }
    return k;
  }

  set(sessionId: string, key: Buffer): void {
    this.map.set(sessionId, key);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.wipe(oldest);
    }
  }

  /** Zeroes the key bytes and forgets them. */
  wipe(sessionId: string): void {
    const k = this.map.get(sessionId);
    if (k) k.fill(0);
    this.map.delete(sessionId);
  }
}

export type LiveEvent =
  | { type: 'attempt'; sessionId: string }
  | { type: 'round'; sessionId: string }
  | { type: 'record'; sessionId: string }
  | { type: 'ended'; sessionId: string };

export class LiveEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(e: LiveEvent): void {
    this.emitter.emit(e.sessionId, e);
  }

  subscribe(sessionId: string, fn: (e: LiveEvent) => void): () => void {
    this.emitter.on(sessionId, fn);
    return () => this.emitter.off(sessionId, fn);
  }
}
