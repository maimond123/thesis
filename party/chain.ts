import type * as Party from 'partykit/server';

// "chain" party — verbatim JSON text broadcast. Each connected client sends
// its own signed per-author event chunks here; everyone else mirrors them
// into a read-only chain. This server is intentionally dumb: it does NOT
// verify signatures (each client verifies on receive). It only relays.
export default class ChainRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    this.room.broadcast(typeof message === 'string' ? message : new Uint8Array(message), [sender.id]);
  }
}

ChainRoom satisfies Party.Worker;
