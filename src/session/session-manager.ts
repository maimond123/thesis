import type {
  AuthoringEvent, Checkpoint, TimestampAnchor,
  SessionMetadata, RawEvent, ProofFile,
} from '../types';
import { sha256, computeGenesisHash, canonicalJsonStringify } from '../crypto/hash-chain';
import { generateSigningKeyPair, exportPublicKey, signData } from '../crypto/signing';
import { generateCommitment, type TimestampCommitment } from '../crypto/timestamp';
import { EventStore } from './event-store';
import { saveSession, loadSession, clearSession } from './persistence';
import { cloudSave, cloudLoad, cloudList } from './cloud-sync';

const APP_VERSION = '0.1.0';
const CHECKPOINT_INTERVAL_MS = 60_000;
const CHECKPOINT_EVENT_THRESHOLD = 500;
const AUTOSAVE_INTERVAL_MS = 2_000;
const CLOUD_SAVE_INTERVAL_MS = 10_000;

export type SessionState = 'idle' | 'recording' | 'ended';

export class SessionManager {
  private metadata!: SessionMetadata;
  private eventStore!: EventStore;
  private keyPair!: CryptoKeyPair;
  private privateKeyJwk!: JsonWebKey;
  private checkpoints: Checkpoint[] = [];
  private anchors: TimestampAnchor[] = [];
  private checkpointTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private cloudSaveTimer: number | null = null;
  private lastCheckpointSeq = -1;
  private lastCloudSaveCount = 0;
  private _state: SessionState = 'idle';
  private getDocument: () => string = () => '';

  // Callbacks for UI updates
  onEventAdded?: (count: number) => void;
  onCheckpoint?: (checkpoint: Checkpoint, commitment: TimestampCommitment) => void;
  onStateChange?: (state: SessionState) => void;
  onCloudSync?: (status: 'saving' | 'saved' | 'error', message?: string) => void;

  get state(): SessionState {
    return this._state;
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.onStateChange?.(state);
  }

  // ─── Check for recoverable session ───────────────────────────────

  async hasRecoverableSession(): Promise<boolean> {
    const saved = await loadSession();
    return saved !== null;
  }

  async recover(getDocument: () => string, setDocument: (doc: string) => void): Promise<boolean> {
    // Try IndexedDB first, then localStorage emergency save
    let saved = await loadSession();
    if (!saved) {
      try {
        const emergency = localStorage.getItem('thesis-emergency-save');
        if (emergency) {
          saved = JSON.parse(emergency);
          localStorage.removeItem('thesis-emergency-save');
        }
      } catch {
        // ignore parse errors
      }
    }
    if (!saved) return false;

    this.getDocument = getDocument;

    // Re-import the private key
    this.keyPair = {
      privateKey: await crypto.subtle.importKey(
        'jwk', saved.privateKeyJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, ['sign']
      ),
      publicKey: await crypto.subtle.importKey(
        'jwk', saved.metadata.publicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, ['verify']
      ),
    };
    this.privateKeyJwk = saved.privateKeyJwk;

    this.metadata = saved.metadata;
    this.checkpoints = saved.checkpoints;
    this.anchors = saved.anchors;
    this.lastCheckpointSeq = this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1].atSeq
      : -1;

    // Rebuild event store from saved events
    this.eventStore = EventStore.fromEvents(saved.events, this.metadata.genesisHash);

    // Restore document content
    setDocument(saved.document);

    // Restart timers
    this.checkpointTimer = window.setInterval(() => {
      this.maybeCheckpoint();
    }, CHECKPOINT_INTERVAL_MS);

    this.autosaveTimer = window.setInterval(() => {
      this.persistNow();
    }, AUTOSAVE_INTERVAL_MS);

    this.startCloudSync();

    this.setState('recording');
    this.onEventAdded?.(this.eventStore.getCount());
    return true;
  }

  // ─── Load from cloud ─────────────────────────────────────────────

  async recoverFromCloud(
    sessionId: string,
    getDocument: () => string,
    setDocument: (doc: string) => void,
  ): Promise<boolean> {
    const saved = await cloudLoad(sessionId);
    if (!saved) return false;

    this.getDocument = getDocument;

    this.keyPair = {
      privateKey: await crypto.subtle.importKey(
        'jwk', saved.privateKeyJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, ['sign']
      ),
      publicKey: await crypto.subtle.importKey(
        'jwk', saved.metadata.publicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, ['verify']
      ),
    };
    this.privateKeyJwk = saved.privateKeyJwk;
    this.metadata = saved.metadata;
    this.checkpoints = saved.checkpoints;
    this.anchors = saved.anchors;
    this.lastCheckpointSeq = this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1].atSeq
      : -1;

    this.eventStore = EventStore.fromEvents(saved.events, this.metadata.genesisHash);
    setDocument(saved.document);

    this.checkpointTimer = window.setInterval(() => {
      this.maybeCheckpoint();
    }, CHECKPOINT_INTERVAL_MS);
    this.autosaveTimer = window.setInterval(() => {
      this.persistNow();
    }, AUTOSAVE_INTERVAL_MS);
    this.startCloudSync();

    this.setState('recording');
    this.onEventAdded?.(this.eventStore.getCount());
    return true;
  }

  // ─── List cloud sessions ─────────────────────────────────────────

  async listCloudSessions() {
    return cloudList();
  }

  // ─── Start fresh session ─────────────────────────────────────────

  async start(getDocument: () => string): Promise<void> {
    await clearSession();

    this.getDocument = getDocument;
    this.keyPair = await generateSigningKeyPair();
    const publicKey = await exportPublicKey(this.keyPair);

    // Export private key for persistence (extractable was set to true)
    this.privateKeyJwk = await crypto.subtle.exportKey('jwk', this.keyPair.privateKey);

    const metaForHash: Record<string, unknown> = {
      sessionId: crypto.randomUUID(),
      startTime: new Date().toISOString(),
      perfTimeOrigin: performance.now(),
      publicKey,
      appVersion: APP_VERSION,
    };

    const genesisHash = await computeGenesisHash(metaForHash);

    this.metadata = {
      sessionId: metaForHash.sessionId as string,
      startTime: metaForHash.startTime as string,
      endTime: '',
      perfTimeOrigin: metaForHash.perfTimeOrigin as number,
      publicKey,
      appVersion: APP_VERSION,
      genesisHash,
    };

    this.eventStore = new EventStore(genesisHash);
    this.checkpoints = [];
    this.anchors = [];
    this.lastCheckpointSeq = -1;

    // Start periodic checkpoint timer
    this.checkpointTimer = window.setInterval(() => {
      this.maybeCheckpoint();
    }, CHECKPOINT_INTERVAL_MS);

    // Start autosave timer
    this.autosaveTimer = window.setInterval(() => {
      this.persistNow();
    }, AUTOSAVE_INTERVAL_MS);

    this.startCloudSync();

    this.setState('recording');
  }

  handleEvent(raw: RawEvent): void {
    if (this._state !== 'recording') return;
    this.eventStore.append(raw);
    this.onEventAdded?.(this.eventStore.getCount());

    // Check event threshold for checkpoint
    const count = this.eventStore.getCount();
    if (count - this.lastCheckpointSeq > CHECKPOINT_EVENT_THRESHOLD) {
      this.maybeCheckpoint();
    }
  }

  private async maybeCheckpoint(): Promise<void> {
    await this.eventStore.flush();
    const events = this.eventStore.getEvents();
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    if (lastEvent.seq === this.lastCheckpointSeq) return;

    const checkpoint = await this.createCheckpoint(lastEvent);
    this.checkpoints.push(checkpoint);
    this.lastCheckpointSeq = lastEvent.seq;

    const commitment = await generateCommitment(checkpoint);
    this.onCheckpoint?.(checkpoint, commitment);

    // Persist immediately after checkpoint
    this.persistNow();
  }

  private async createCheckpoint(lastEvent: AuthoringEvent): Promise<Checkpoint> {
    const docContent = this.getDocument();
    const documentHash = await sha256(docContent);

    const payload = canonicalJsonStringify({
      atSeq: lastEvent.seq,
      eventHash: lastEvent.hash,
      documentHash,
      wallClock: new Date().toISOString(),
    });

    const signature = await signData(this.keyPair.privateKey, payload);

    return {
      atSeq: lastEvent.seq,
      eventHash: lastEvent.hash,
      documentHash,
      wallClock: new Date().toISOString(),
      signature,
    };
  }

  addAnchor(anchor: TimestampAnchor): void {
    this.anchors.push(anchor);
    this.persistNow();
  }

  async end(): Promise<ProofFile> {
    if (this._state !== 'recording') throw new Error('No active session');

    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (this.autosaveTimer !== null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (this.cloudSaveTimer !== null) {
      clearInterval(this.cloudSaveTimer);
      this.cloudSaveTimer = null;
    }

    await this.eventStore.flush();

    // Create final checkpoint
    const events = this.eventStore.getEvents();
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      if (lastEvent.seq !== this.lastCheckpointSeq) {
        const checkpoint = await this.createCheckpoint(lastEvent);
        this.checkpoints.push(checkpoint);
      }
    }

    this.metadata.endTime = new Date().toISOString();
    const finalDocument = this.getDocument();
    const finalDocHash = await sha256(finalDocument);
    const lastHash = this.eventStore.getLastHash();

    const finalPayload = canonicalJsonStringify({
      sessionId: this.metadata.sessionId,
      genesisHash: this.metadata.genesisHash,
      lastEventHash: lastHash,
      finalDocumentHash: finalDocHash,
      endTime: this.metadata.endTime,
    });

    const finalSignature = await signData(this.keyPair.privateKey, finalPayload);

    // Clear autosave — session is properly ended
    await clearSession();

    this.setState('ended');

    return {
      version: 1,
      session: { ...this.metadata },
      events: this.eventStore.getEvents(),
      checkpoints: [...this.checkpoints],
      timestampAnchors: [...this.anchors],
      finalDocument,
      finalSignature,
    };
  }

  // ─── Cloud sync ──────────────────────────────────────────────────

  private startCloudSync(): void {
    // Immediate first save
    this.cloudPersist();
    this.cloudSaveTimer = window.setInterval(() => {
      this.cloudPersist();
    }, CLOUD_SAVE_INTERVAL_MS);
  }

  private async cloudPersist(): Promise<void> {
    if (this._state !== 'recording') return;
    const currentCount = this.eventStore.getCount();
    if (currentCount === this.lastCloudSaveCount) return; // no new events

    await this.eventStore.flush();
    this.onCloudSync?.('saving');
    try {
      await cloudSave(
        this.metadata,
        this.eventStore.getEvents(),
        this.checkpoints,
        this.anchors,
        this.getDocument(),
        this.privateKeyJwk,
      );
      this.lastCloudSaveCount = currentCount;
      this.onCloudSync?.('saved');
    } catch (err) {
      this.onCloudSync?.('error', String(err));
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────

  private async persistNow(): Promise<void> {
    if (this._state !== 'recording') return;
    await this.eventStore.flush();
    try {
      await saveSession(
        this.metadata,
        this.eventStore.getEvents(),
        this.checkpoints,
        this.anchors,
        this.getDocument(),
        this.privateKeyJwk,
      );
    } catch {
      // IndexedDB can fail silently — don't break the session
    }
  }

  // Synchronous save via localStorage — used in beforeunload where async doesn't work
  forceSaveSync(): void {
    if (this._state !== 'recording') return;
    try {
      const data = JSON.stringify({
        metadata: this.metadata,
        events: this.eventStore.getEvents(),
        checkpoints: this.checkpoints,
        anchors: this.anchors,
        document: this.getDocument(),
        privateKeyJwk: this.privateKeyJwk,
      });
      localStorage.setItem('thesis-emergency-save', data);
    } catch {
      // Best effort — localStorage has size limits
    }
  }

  getEventCount(): number {
    return this.eventStore?.getCount() ?? 0;
  }

  getCheckpoints(): Checkpoint[] {
    return this.checkpoints;
  }
}
