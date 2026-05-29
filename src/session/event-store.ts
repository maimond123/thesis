import type { AuthoringEvent, RawEvent } from '../types';
import { computeEventHash } from '../crypto/hash-chain';

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
