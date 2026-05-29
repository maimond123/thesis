import type * as Party from 'partykit/server';

// Chain party — verbatim JSON broadcast for per-author signed event chunks.
// This server intentionally does NOT verify signatures: each peer verifies on
// receive. The server's only jobs:
//   1. Broadcast incoming messages live to other peers in the room.
//   2. Persist every message and replay the full history to any peer that
//      connects later, so a late joiner ends up with the same mirror chains
//      as everyone else.

const MSG_PREFIX = 'msg:';

export default class ChainRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection) {
    const stored = await this.room.storage.list({ prefix: MSG_PREFIX });
    // Map iteration is insertion-ordered, and our keys are timestamp-prefixed,
    // so this replays in chronological order.
    for (const [, value] of stored) {
      try { conn.send(value as string); }
      catch { /* connection may close mid-replay; fine */ }
    }
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== 'string') return;
    // Timestamp-prefixed key (padded so lexical sort = chronological) plus a
    // random suffix so two messages in the same ms don't collide.
    const ts = Date.now().toString().padStart(16, '0');
    const key = `${MSG_PREFIX}${ts}:${crypto.randomUUID()}`;
    await this.room.storage.put(key, message);
    this.room.broadcast(message, [sender.id]);
  }
}

ChainRoom satisfies Party.Worker;
