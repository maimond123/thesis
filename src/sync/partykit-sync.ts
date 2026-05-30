import YPartyKitProvider from 'y-partykit/provider';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

// Sync layer — two independent connections to PartyKit:
//
//   1. y-partykit's WebSocket to the "main" party: Yjs doc sync + Awareness.
//      Carries binary frames; we don't touch it.
//
//   2. A plain WebSocket to the "chain" party: per-author signed event chunks
//      as JSON text. The chain party is dumb broadcast — peers mirror what
//      they receive into read-only EventStores keyed by author thumbprint.
//
// Keeping these on separate parties prevents y-protocols from trying to
// decode our text JSON as Yjs binary updates (which crashes the server).

const PARTYKIT_HOST = (import.meta.env.VITE_PARTYKIT_HOST as string | undefined) ?? 'localhost:1999';
const ROOM_PREFIX = 'thesis';

export interface ChainMessage {
  kind: 'chain';
  fromThumbprint: string;
  payload: unknown;
}

export interface SyncOptions {
  fileId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  onChainMessage: (msg: ChainMessage) => void;
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected') => void;
}

function chainWsUrl(host: string, room: string): string {
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'ws' : 'wss';
  return `${protocol}://${host}/parties/chain/${room}`;
}

export class PartyKitSync {
  private yjsProvider: YPartyKitProvider | null = null;
  private chainSocket: WebSocket | null = null;
  private chainQueue: string[] = [];
  private opts: SyncOptions;
  private chainReconnectTimer: number | null = null;

  constructor(opts: SyncOptions) {
    this.opts = opts;
  }

  connect(): void {
    const room = `${ROOM_PREFIX}-${this.opts.fileId}`;
    this.opts.onStatus?.('connecting');

    // Yjs provider on "main" party.
    this.yjsProvider = new YPartyKitProvider(PARTYKIT_HOST, room, this.opts.ydoc, {
      awareness: this.opts.awareness,
    });
    this.yjsProvider.on('status', (event: { status: 'connecting' | 'connected' | 'disconnected' }) => {
      this.opts.onStatus?.(event.status);
    });

    this.connectChain(room);
  }

  private connectChain(room: string): void {
    if (this.chainSocket && this.chainSocket.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(chainWsUrl(PARTYKIT_HOST, room));
    this.chainSocket = ws;

    ws.addEventListener('open', () => {
      // Drain any messages queued while disconnected.
      while (this.chainQueue.length > 0) {
        const msg = this.chainQueue.shift();
        if (msg) ws.send(msg);
      }
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const parsed = JSON.parse(ev.data) as ChainMessage;
        if (parsed?.kind === 'chain') this.opts.onChainMessage(parsed);
      } catch {
        // not a chain message
      }
    });

    ws.addEventListener('close', () => {
      // Auto-reconnect with a small backoff; chain channel is essential for
      // multi-author attribution to be live.
      if (this.chainReconnectTimer !== null) return;
      this.chainReconnectTimer = window.setTimeout(() => {
        this.chainReconnectTimer = null;
        this.connectChain(room);
      }, 1500);
    });

    ws.addEventListener('error', () => {
      // close will fire after; reconnect handled there
    });
  }

  sendChainMessage(msg: ChainMessage): void {
    const data = JSON.stringify(msg);
    if (this.chainSocket && this.chainSocket.readyState === WebSocket.OPEN) {
      this.chainSocket.send(data);
    } else {
      // Queue while reconnecting. Bounded to prevent memory blowup if the
      // chain socket stays down — beyond ~5k events we just drop (the cloud
      // tier still has them; peers can pull on reconnect via session resync
      // in a future commit).
      if (this.chainQueue.length < 5_000) this.chainQueue.push(data);
    }
  }

  // Exposed so the keystroke-capture layer can distinguish Yjs updates that
  // came in from peers (origin === provider) from local edits (origin !== provider).
  getProvider(): YPartyKitProvider | null {
    return this.yjsProvider;
  }

  disconnect(): void {
    this.yjsProvider?.destroy();
    this.yjsProvider = null;
    this.chainSocket?.close();
    this.chainSocket = null;
    if (this.chainReconnectTimer !== null) {
      clearTimeout(this.chainReconnectTimer);
      this.chainReconnectTimer = null;
    }
    this.opts.onStatus?.('disconnected');
  }
}
