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
  authorThumbprint: string; // JWK thumbprint of author's public key
  // performance.now() at capture time. Page-relative: it resets to 0 on every
  // page load, so values from before and after a tab kill are NOT directly
  // comparable. Used for intra-page fine-grained timing (inter-keystroke
  // gaps within a single browser session). Cross-page accumulation uses
  // wallClock below instead.
  timestamp: number;
  // ms since UNIX epoch (performance.timeOrigin + performance.now()) at
  // capture time. Comparable across page loads and across peers, so it's
  // the field the verifier uses to compute calendar span, active writing
  // time, distinct sessions, and any other "how much real time passed"
  // statistic. Optional because pre-0.4.0 events don't carry it; the
  // activity stats degrade gracefully (calendar span unknown) when missing.
  wallClock?: number;
  type: EventType;
  from: number;            // position in doc BEFORE change (in the AUTHOR's local view)
  to: number;              // end of replaced range
  inserted: string;        // text inserted (empty for pure deletions)
  deleted: string;         // text deleted (empty for pure inserts)
  cursorAfter: number;     // cursor position after change
  // Base64-encoded Yjs binary updateV2 representing this edit in CRDT-correct
  // form. When present, replay applies this to a fresh Y.Doc so the merged
  // document reconstructs exactly as Yjs computed it live, even across
  // concurrent multi-author edits. Older proofs without this field replay
  // using the legacy position-based path (correct for single-author only).
  yjsUpdate?: string;
  hash: string;            // SHA-256 hex of this event
  prevHash: string;        // SHA-256 hex of previous event (or genesis)
}

// ─── Raw event before hashing ──────────────────────────────────────
// Author is attached by the EventStore (it knows whose chain it is).

export type RawEvent = Omit<AuthoringEvent, 'hash' | 'prevHash' | 'seq' | 'authorThumbprint'>;

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
  fileId: string;          // identifies WHICH file these events belong to
  startTime: string;       // ISO 8601 wall-clock
  endTime: string;
  perfTimeOrigin: number;  // performance.now() at session start
  publicKey: JsonWebKey;   // local author's public key
  localAuthorThumbprint: string; // JWK thumbprint of the local author
  authors: PublicIdentitySnapshot[]; // roster — anyone who appears in events[]
  appVersion: string;
  genesisHash: string;     // genesis of the LOCAL author's chain (derived from {fileId, localAuthorThumbprint})
}

// Snapshot of a public identity captured into a proof file so verifiers can
// look up an author's public key by thumbprint without an external directory.
export interface PublicIdentitySnapshot {
  thumbprint: string;
  handle: string;
  publicKey: JsonWebKey;
}

// ─── Proof File ────────────────────────────────────────────────────

// Schema versions:
//   v1 — events carry CodeMirror positions (from/to/inserted/deleted) only.
//        Replay reconstructs the doc by applying those positions to a virgin
//        text buffer. Correct for single-author sessions only; multi-author
//        replay can diverge from what was actually on screen.
//   v2 — events additionally carry `yjsUpdate`, the binary CRDT delta the
//        author's edit produced. Replay applies these to a fresh Y.Doc so
//        the merged document reconstructs exactly as Yjs computed it live.
//        Both versions parse, verify, and replay; new sessions are stamped v2.
export interface ProofFile {
  version: 1 | 2;
  session: SessionMetadata;
  events: AuthoringEvent[];
  checkpoints: Checkpoint[];
  timestampAnchors: TimestampAnchor[];
  finalDocument: string;
  finalSignature: string;
}
