// ─── Event Types ───────────────────────────────────────────────────

export type EventType =
  | 'input.type'
  | 'input.paste'
  | 'input.drop'
  | 'input.complete'
  | 'delete.backward'
  | 'delete.forward'
  | 'delete.selection'
  | 'delete.cut'
  | 'undo'
  | 'redo'
  | 'unknown';

// ─── Authoring Event ───────────────────────────────────────────────

export interface AuthoringEvent {
  seq: number;
  timestamp: number;       // performance.now() relative to session start
  type: EventType;
  from: number;            // position in doc BEFORE change
  to: number;              // end of replaced range
  inserted: string;        // text inserted (empty for pure deletions)
  deleted: string;         // text deleted (empty for pure inserts)
  cursorAfter: number;     // cursor position after change
  hash: string;            // SHA-256 hex of this event
  prevHash: string;        // SHA-256 hex of previous event (or genesis)
}

// ─── Raw event before hashing ──────────────────────────────────────

export type RawEvent = Omit<AuthoringEvent, 'hash' | 'prevHash' | 'seq'>;

// ─── Checkpoint ────────────────────────────────────────────────────

export interface Checkpoint {
  atSeq: number;           // last event seq covered
  eventHash: string;       // hash of event at atSeq
  documentHash: string;    // SHA-256 of full document content
  wallClock: string;       // ISO 8601 timestamp
  signature: string;       // ECDSA P-256 signature (base64url)
}

// ─── Timestamp Anchor ──────────────────────────────────────────────

export interface TimestampAnchor {
  checkpointSeq: number;
  commitHash: string;
  method: string;          // 'opentimestamps' | 'manual' | 'twitter' | etc.
  proof: string;           // proof data (OTS base64, URL, etc.)
  createdAt: string;
}

// ─── Session Metadata ──────────────────────────────────────────────

export interface SessionMetadata {
  sessionId: string;
  startTime: string;       // ISO 8601 wall-clock
  endTime: string;
  perfTimeOrigin: number;  // performance.now() at session start
  publicKey: JsonWebKey;
  appVersion: string;
  genesisHash: string;
}

// ─── Proof File ────────────────────────────────────────────────────

export interface ProofFile {
  version: 1;
  session: SessionMetadata;
  events: AuthoringEvent[];
  checkpoints: Checkpoint[];
  timestampAnchors: TimestampAnchor[];
  finalDocument: string;
  finalSignature: string;
}
