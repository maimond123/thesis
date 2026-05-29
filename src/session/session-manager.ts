import type {
  AuthoringEvent, Checkpoint, TimestampAnchor,
  SessionMetadata, RawEvent, ProofFile, PublicIdentitySnapshot,
} from '../types';
import { sha256, canonicalJsonStringify, deriveChainGenesis } from '../crypto/hash-chain';
import { generateCommitment, type TimestampCommitment } from '../crypto/timestamp';
import { EventStore } from './event-store';
import { saveSession, loadSession, clearSession } from './persistence';
import { cloudSave, cloudLoad, cloudList } from './cloud-sync';
import type { IdentityStore } from '../identity/identity-store';

const APP_VERSION = '0.3.0';
const CHECKPOINT_INTERVAL_MS = 60_000;
const CHECKPOINT_EVENT_THRESHOLD = 500;
const AUTOSAVE_INTERVAL_MS = 250;
const EMERGENCY_SAVE_INTERVAL_MS = 30_000;
const CLOUD_SAVE_INTERVAL_MS = 10_000;

export type SessionState = 'idle' | 'recording' | 'ended';

// Snapshot of a co-author's identity, captured at the moment we first see them
// in a chain message. Lets us emit a complete `authors` roster in the proof file.
export interface CoAuthorRef {
  thumbprint: string;
  handle: string;
  publicKey: JsonWebKey;
}

export class SessionManager {
  private readonly identityStore: IdentityStore;
  private readonly fileId: string;
  private metadata!: SessionMetadata;
  private localChain!: EventStore;
  // Read-only mirrors of each co-author's chain, keyed by their thumbprint.
  private mirrorChains: Map<string, EventStore> = new Map();
  private coAuthorIdentities: Map<string, CoAuthorRef> = new Map();
  private checkpoints: Checkpoint[] = [];
  private anchors: TimestampAnchor[] = [];
  private checkpointTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private emergencySaveTimer: number | null = null;
  private cloudSaveTimer: number | null = null;
  private lastCheckpointSeq = -1;
  private lastCloudSaveCount = 0;
  private lastPersistedCount = 0;
  private persistInFlight = false;
  private _state: SessionState = 'idle';
  private getDocument: () => string = () => '';

  public lastIdbSaveAt: number | null = null;
  public lastCloudSaveAt: number | null = null;
  public lastEmergencySaveAt: number | null = null;

  onEventAdded?: (totalCount: number) => void;
  onCheckpoint?: (checkpoint: Checkpoint, commitment: TimestampCommitment) => void;
  onStateChange?: (state: SessionState) => void;
  onCloudSync?: (status: 'saving' | 'saved' | 'error', message?: string) => void;
  // Fires after a LOCAL event has been hashed + appended; payload is suitable
  // for broadcasting to peers via the chain channel.
  onLocalEventAppended?: (authorThumbprint: string, event: AuthoringEvent) => void;

  constructor(identityStore: IdentityStore, fileId: string) {
    this.identityStore = identityStore;
    this.fileId = fileId;
  }

  get state(): SessionState {
    return this._state;
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.onStateChange?.(state);
  }

  async hasRecoverableSession(): Promise<boolean> {
    const saved = await loadSession(this.fileId);
    return saved !== null;
  }

  async recover(getDocument: () => string, setDocument: (doc: string) => void): Promise<boolean> {
    let saved = await loadSession(this.fileId);
    if (!saved) {
      try {
        const emergencyKey = `thesis-emergency-save:${this.fileId}`;
        const emergency = localStorage.getItem(emergencyKey);
        if (emergency) {
          saved = JSON.parse(emergency);
          localStorage.removeItem(emergencyKey);
        }
      } catch { /* ignore */ }
    }
    if (!saved) return false;

    const self = this.identityStore.getSelf();
    if (saved.metadata.localAuthorThumbprint && saved.metadata.localAuthorThumbprint !== self.thumbprint) {
      console.warn('[thesis] Saved session belongs to a different identity; not recovering.');
      return false;
    }
    if (saved.metadata.fileId && saved.metadata.fileId !== this.fileId) {
      console.warn('[thesis] Saved session belongs to a different file; not recovering.');
      return false;
    }

    this.getDocument = getDocument;
    this.metadata = saved.metadata;
    this.checkpoints = saved.checkpoints;
    this.anchors = saved.anchors;
    this.lastCheckpointSeq = this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1].atSeq
      : -1;

    // Group saved events by author into local + mirror chains.
    const localEvents: AuthoringEvent[] = [];
    const remoteEvents: Map<string, AuthoringEvent[]> = new Map();
    for (const ev of saved.events) {
      if (ev.authorThumbprint === self.thumbprint) {
        localEvents.push(ev);
      } else {
        const arr = remoteEvents.get(ev.authorThumbprint) ?? [];
        arr.push(ev);
        remoteEvents.set(ev.authorThumbprint, arr);
      }
    }

    const localGenesis = await deriveChainGenesis(this.fileId, self.thumbprint);
    this.localChain = EventStore.fromEvents(localEvents, self.thumbprint, localGenesis);

    for (const [thumb, events] of remoteEvents) {
      const genesis = await deriveChainGenesis(this.fileId, thumb);
      this.mirrorChains.set(thumb, EventStore.fromEvents(events, thumb, genesis));
    }

    // Rehydrate co-author identity snapshots from metadata.authors.
    for (const a of saved.metadata.authors ?? []) {
      if (a.thumbprint !== self.thumbprint) {
        this.coAuthorIdentities.set(a.thumbprint, {
          thumbprint: a.thumbprint,
          handle: a.handle,
          publicKey: a.publicKey,
        });
      }
    }

    setDocument(saved.document);

    this.startTimers();
    this.setState('recording');
    this.onEventAdded?.(this.getTotalEventCount());
    return true;
  }

  async recoverFromCloud(
    sessionId: string,
    getDocument: () => string,
    setDocument: (doc: string) => void,
  ): Promise<boolean> {
    const saved = await cloudLoad(sessionId);
    if (!saved) return false;

    const self = this.identityStore.getSelf();
    if (saved.metadata.localAuthorThumbprint && saved.metadata.localAuthorThumbprint !== self.thumbprint) {
      console.warn('[thesis] Cloud session belongs to a different identity; refusing to recover.');
      return false;
    }

    this.getDocument = getDocument;
    this.metadata = saved.metadata;
    this.checkpoints = saved.checkpoints;
    this.anchors = saved.anchors;
    this.lastCheckpointSeq = this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1].atSeq
      : -1;

    const localEvents: AuthoringEvent[] = [];
    const remoteEvents: Map<string, AuthoringEvent[]> = new Map();
    for (const ev of saved.events) {
      if (ev.authorThumbprint === self.thumbprint) localEvents.push(ev);
      else {
        const arr = remoteEvents.get(ev.authorThumbprint) ?? [];
        arr.push(ev);
        remoteEvents.set(ev.authorThumbprint, arr);
      }
    }

    const localGenesis = await deriveChainGenesis(this.fileId, self.thumbprint);
    this.localChain = EventStore.fromEvents(localEvents, self.thumbprint, localGenesis);
    for (const [thumb, events] of remoteEvents) {
      const genesis = await deriveChainGenesis(this.fileId, thumb);
      this.mirrorChains.set(thumb, EventStore.fromEvents(events, thumb, genesis));
    }

    setDocument(saved.document);
    this.startTimers();
    this.setState('recording');
    this.onEventAdded?.(this.getTotalEventCount());
    return true;
  }

  async listCloudSessions() {
    return cloudList();
  }

  async start(getDocument: () => string): Promise<void> {
    await clearSession(this.fileId);
    this.getDocument = getDocument;

    const self = this.identityStore.getSelf();
    const localGenesis = await deriveChainGenesis(this.fileId, self.thumbprint);

    this.metadata = {
      sessionId: crypto.randomUUID(),
      fileId: this.fileId,
      startTime: new Date().toISOString(),
      endTime: '',
      perfTimeOrigin: performance.now(),
      publicKey: self.publicKey,
      localAuthorThumbprint: self.thumbprint,
      authors: [{ thumbprint: self.thumbprint, handle: self.handle, publicKey: self.publicKey }],
      appVersion: APP_VERSION,
      genesisHash: localGenesis,
    };

    this.localChain = new EventStore(self.thumbprint, localGenesis);
    this.mirrorChains.clear();
    this.coAuthorIdentities.clear();
    this.checkpoints = [];
    this.anchors = [];
    this.lastCheckpointSeq = -1;
    this.lastCloudSaveCount = 0;
    this.lastPersistedCount = 0;

    this.startTimers();
    this.setState('recording');
  }

  private startTimers(): void {
    this.checkpointTimer = window.setInterval(() => this.maybeCheckpoint(), CHECKPOINT_INTERVAL_MS);
    this.autosaveTimer = window.setInterval(() => this.persistNow(), AUTOSAVE_INTERVAL_MS);
    this.emergencySaveTimer = window.setInterval(() => this.forceSaveSync(), EMERGENCY_SAVE_INTERVAL_MS);
    this.startCloudSync();
  }

  handleEvent(raw: RawEvent): void {
    if (this._state !== 'recording') return;
    this.localChain.append(raw);
    this.onEventAdded?.(this.getTotalEventCount());

    // After the hash queue settles, fetch the just-appended event and broadcast.
    void this.localChain.flush().then(() => {
      const events = this.localChain.getEvents();
      const latest = events[events.length - 1];
      if (latest) this.onLocalEventAppended?.(latest.authorThumbprint, latest);
    });

    this.persistNow();

    const count = this.localChain.getCount();
    if (count - this.lastCheckpointSeq > CHECKPOINT_EVENT_THRESHOLD) {
      this.maybeCheckpoint();
    }
  }

  // Called when a chain message arrives from a peer over the live-sync channel.
  // Lazily creates a mirror chain for the author on first event seen, then
  // verifies the incoming event before accepting it.
  //
  // Verification (B3): the event must (1) carry the claimed author's thumbprint,
  // (2) line up sequentially with our current mirror head, (3) prev-link to it
  // (or to the derived genesis on the very first event), and (4) the claimed
  // hash must match what we recompute from the event's contents. Failure to
  // meet any of these means the sender either has a stale view of the chain
  // or is actively spoofing — either way we drop the event.
  async appendRemoteEvent(authorThumbprint: string, event: AuthoringEvent, coAuthor?: CoAuthorRef): Promise<void> {
    if (authorThumbprint === this.metadata?.localAuthorThumbprint) return;

    let mirror = this.mirrorChains.get(authorThumbprint);
    if (!mirror) {
      const genesis = await deriveChainGenesis(this.fileId, authorThumbprint);
      mirror = new EventStore(authorThumbprint, genesis);
      this.mirrorChains.set(authorThumbprint, mirror);
    }

    const result = await mirror.appendVerified(event);
    if (!result.ok) {
      console.warn(
        `[thesis] rejected chain event from ${authorThumbprint.slice(0, 8)}…: ${result.reason} — ${result.detail}`,
      );
      return;
    }

    if (coAuthor && !this.coAuthorIdentities.has(authorThumbprint)) {
      this.coAuthorIdentities.set(authorThumbprint, coAuthor);
    }

    this.onEventAdded?.(this.getTotalEventCount());
    this.persistNow();
  }

  private async maybeCheckpoint(): Promise<void> {
    await this.localChain.flush();
    const events = this.localChain.getEvents();
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    if (lastEvent.seq === this.lastCheckpointSeq) return;

    const checkpoint = await this.createCheckpoint(lastEvent);
    this.checkpoints.push(checkpoint);
    this.lastCheckpointSeq = lastEvent.seq;

    const commitment = await generateCommitment(checkpoint);
    this.onCheckpoint?.(checkpoint, commitment);

    this.persistNow();
  }

  private async createCheckpoint(lastEvent: AuthoringEvent): Promise<Checkpoint> {
    const docContent = this.getDocument();
    const documentHash = await sha256(docContent);
    const wallClock = new Date().toISOString();

    const payload = canonicalJsonStringify({
      atSeq: lastEvent.seq,
      eventHash: lastEvent.hash,
      documentHash,
      wallClock,
    });

    const signature = await this.identityStore.signWithSelf(payload);

    return {
      atSeq: lastEvent.seq,
      eventHash: lastEvent.hash,
      documentHash,
      wallClock,
      signature,
    };
  }

  addAnchor(anchor: TimestampAnchor): void {
    this.anchors.push(anchor);
    this.persistNow();
  }

  async snapshot(): Promise<ProofFile> {
    if (this._state !== 'recording') throw new Error('No active session to snapshot');
    return this.buildProofFile(/* finalising */ false);
  }

  async end(): Promise<ProofFile> {
    if (this._state !== 'recording') throw new Error('No active session');

    if (this.checkpointTimer !== null) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; }
    if (this.autosaveTimer !== null) { clearInterval(this.autosaveTimer); this.autosaveTimer = null; }
    if (this.emergencySaveTimer !== null) { clearInterval(this.emergencySaveTimer); this.emergencySaveTimer = null; }
    if (this.cloudSaveTimer !== null) { clearInterval(this.cloudSaveTimer); this.cloudSaveTimer = null; }

    await this.localChain.flush();

    // Final local-chain checkpoint covering any tail events.
    const events = this.localChain.getEvents();
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      if (lastEvent.seq !== this.lastCheckpointSeq) {
        this.checkpoints.push(await this.createCheckpoint(lastEvent));
      }
    }

    this.metadata.endTime = new Date().toISOString();
    const proof = await this.buildProofFile(/* finalising */ true);

    await clearSession(this.fileId);
    this.setState('ended');
    return proof;
  }

  private async buildProofFile(finalising: boolean): Promise<ProofFile> {
    // Flush every chain before reading events.
    await this.localChain.flush();
    for (const m of this.mirrorChains.values()) await m.flush();

    const finalDocument = this.getDocument();
    const finalDocHash = await sha256(finalDocument);
    const lastHash = this.localChain.getLastHash();

    const wallClock = finalising ? this.metadata.endTime : new Date().toISOString();

    const signingPayload: Record<string, unknown> = {
      sessionId: this.metadata.sessionId,
      genesisHash: this.metadata.genesisHash,
      lastEventHash: lastHash,
      finalDocumentHash: finalDocHash,
      endTime: wallClock,
    };
    if (!finalising) signingPayload.snapshot = true;
    const finalSignature = await this.identityStore.signWithSelf(canonicalJsonStringify(signingPayload));

    // Union events across all chains, sorted by timestamp so the verifier sees
    // a coherent timeline; per-author chains are reconstructed by grouping on
    // authorThumbprint at verification time.
    const allEvents: AuthoringEvent[] = [
      ...this.localChain.getEvents(),
      ...[...this.mirrorChains.values()].flatMap((m) => m.getEvents()),
    ];
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    const authors: PublicIdentitySnapshot[] = [
      {
        thumbprint: this.metadata.localAuthorThumbprint,
        handle: this.identityStore.getSelf().handle,
        publicKey: this.metadata.publicKey,
      },
      ...[...this.coAuthorIdentities.values()].map((c) => ({
        thumbprint: c.thumbprint,
        handle: c.handle,
        publicKey: c.publicKey,
      })),
    ];

    return {
      version: 1,
      session: {
        ...this.metadata,
        endTime: wallClock,
        authors,
      },
      events: allEvents,
      checkpoints: [...this.checkpoints],
      timestampAnchors: [...this.anchors],
      finalDocument,
      finalSignature,
    };
  }

  private startCloudSync(): void {
    this.cloudPersist();
    this.cloudSaveTimer = window.setInterval(() => this.cloudPersist(), CLOUD_SAVE_INTERVAL_MS);
  }

  private async cloudPersist(): Promise<void> {
    if (this._state !== 'recording') return;
    const currentCount = this.getTotalEventCount();
    if (currentCount === this.lastCloudSaveCount) return;

    await this.localChain.flush();
    this.onCloudSync?.('saving');
    try {
      await cloudSave(
        this.metadata,
        this.getUnionEvents(),
        this.checkpoints,
        this.anchors,
        this.getDocument(),
      );
      this.lastCloudSaveCount = currentCount;
      this.lastCloudSaveAt = Date.now();
      this.onCloudSync?.('saved');
    } catch (err) {
      this.onCloudSync?.('error', String(err));
    }
  }

  private async persistNow(): Promise<void> {
    if (this._state !== 'recording') return;
    if (this.persistInFlight) return;
    const countAtStart = this.getTotalEventCount();
    if (countAtStart === this.lastPersistedCount) return;

    this.persistInFlight = true;
    try {
      await this.localChain.flush();
      await saveSession(
        this.metadata,
        this.getUnionEvents(),
        this.checkpoints,
        this.anchors,
        this.getDocument(),
      );
      this.lastPersistedCount = this.getTotalEventCount();
      this.lastIdbSaveAt = Date.now();
    } catch (err) {
      console.warn('[thesis] IndexedDB save failed:', err);
    } finally {
      this.persistInFlight = false;
    }

    if (this.getTotalEventCount() > this.lastPersistedCount) {
      queueMicrotask(() => this.persistNow());
    }
  }

  forceSaveSync(): void {
    if (this._state !== 'recording') return;
    try {
      const data = JSON.stringify({
        metadata: this.metadata,
        events: this.getUnionEvents(),
        checkpoints: this.checkpoints,
        anchors: this.anchors,
        document: this.getDocument(),
      });
      // Emergency snapshot is also namespaced by fileId so a parallel tab on a
      // different document doesn't overwrite ours.
      localStorage.setItem(`thesis-emergency-save:${this.fileId}`, data);
      this.lastEmergencySaveAt = Date.now();
    } catch (err) {
      console.warn('[thesis] localStorage emergency save failed:', err);
    }
  }

  private getUnionEvents(): AuthoringEvent[] {
    const all: AuthoringEvent[] = [
      ...this.localChain.getEvents(),
      ...[...this.mirrorChains.values()].flatMap((m) => m.getEvents()),
    ];
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  getEventCount(): number {
    return this.localChain?.getCount() ?? 0;
  }

  getTotalEventCount(): number {
    let total = this.localChain?.getCount() ?? 0;
    for (const m of this.mirrorChains.values()) total += m.getCount();
    return total;
  }

  getCheckpoints(): Checkpoint[] {
    return this.checkpoints;
  }

  isFullyPersistedToIdb(): boolean {
    if (!this.localChain) return true;
    return this.getTotalEventCount() === this.lastPersistedCount;
  }

  isFullyPersistedToCloud(): boolean {
    if (!this.localChain) return true;
    return this.getTotalEventCount() === this.lastCloudSaveCount;
  }

  registerCoAuthor(ref: CoAuthorRef): void {
    this.coAuthorIdentities.set(ref.thumbprint, ref);
  }
}
