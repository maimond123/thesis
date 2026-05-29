import type { AuthoringEvent, RawEvent } from '../types';
import { computeEventHash } from '../crypto/hash-chain';

export type AppendVerifiedResult =
  | { ok: true }
  | { ok: false; reason: 'seq-skip' | 'prev-hash-mismatch' | 'author-mismatch' | 'hash-mismatch'; detail: string };

export class EventStore {
  private events: AuthoringEvent[] = [];
  private hashQueue: Promise<void> = Promise.resolve();
  private readonly authorThumbprint: string;
  private readonly genesisHash: string;

  constructor(authorThumbprint: string, genesisHash: string) {
    this.authorThumbprint = authorThumbprint;
    this.genesisHash = genesisHash;
  }

  static fromEvents(
    events: AuthoringEvent[],
    authorThumbprint: string,
    genesisHash: string,
  ): EventStore {
    const store = new EventStore(authorThumbprint, genesisHash);
    store.events = [...events];
    return store;
  }

  append(raw: RawEvent): void {
    this.hashQueue = this.hashQueue.then(async () => {
      const seq = this.events.length;
      const prevHash = seq === 0
        ? this.genesisHash
        : this.events[seq - 1].hash;

      const partial = {
        ...raw,
        authorThumbprint: this.authorThumbprint,
        seq,
        prevHash,
      };
      const hash = await computeEventHash(partial);

      this.events.push({ ...partial, hash });
    });
  }

  async flush(): Promise<void> {
    await this.hashQueue;
  }

  // Accept a pre-hashed AuthoringEvent from a remote peer ONLY after
  // verifying: the sequence number, the prevHash link to our current head,
  // the authorThumbprint, and that the claimed hash matches a local
  // recomputation of the event's contents. Anything that fails any check
  // is silently rejected — the caller decides what to log.
  async appendVerified(event: AuthoringEvent): Promise<AppendVerifiedResult> {
    await this.flush();

    if (event.authorThumbprint !== this.authorThumbprint) {
      return { ok: false, reason: 'author-mismatch', detail: `expected ${this.authorThumbprint.slice(0, 8)}, got ${event.authorThumbprint.slice(0, 8)}` };
    }
    if (event.seq !== this.events.length) {
      return { ok: false, reason: 'seq-skip', detail: `expected seq ${this.events.length}, got ${event.seq}` };
    }
    const expectedPrev = this.events.length === 0
      ? this.genesisHash
      : this.events[this.events.length - 1].hash;
    if (event.prevHash !== expectedPrev) {
      return { ok: false, reason: 'prev-hash-mismatch', detail: 'prevHash does not link to our current head' };
    }
    const { hash: _hash, ...rest } = event;
    const recomputed = await computeEventHash(rest);
    if (recomputed !== event.hash) {
      return { ok: false, reason: 'hash-mismatch', detail: 'recomputed hash differs from claimed hash' };
    }
    this.events.push(event);
    return { ok: true };
  }

  getEvents(): AuthoringEvent[] {
    return this.events;
  }

  getAuthorThumbprint(): string {
    return this.authorThumbprint;
  }

  getGenesisHash(): string {
    return this.genesisHash;
  }

  getLastHash(): string {
    if (this.events.length === 0) return this.genesisHash;
    return this.events[this.events.length - 1].hash;
  }

  getCount(): number {
    return this.events.length;
  }

  getLastEvent(): AuthoringEvent | null {
    return this.events.length > 0 ? this.events[this.events.length - 1] : null;
  }
}
