import type * as Party from 'partykit/server';
import { onConnect } from 'y-partykit';

// "main" party — purely Yjs sync. y-partykit owns the connection. Awareness
// (cursors / presence) rides on the same socket. No chain-channel handling
// here — that lives on the separate "chain" party so y-protocols doesn't
// try to decode our text JSON as a binary Yjs update.
export default class YjsRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection) {
    return onConnect(conn, this.room, {
      persist: { mode: 'snapshot' },
    });
  }
}

YjsRoom satisfies Party.Worker;
