// Comment threads are a parallel, signed record of review activity layered
// on top of the keystroke authorship chain. The chain is unchanged by
// comments; each comment is its own ECDSA-signed payload, verifiable
// independently. They live in the same Y.Doc so y-partykit syncs them
// to peers for free, and they ride along in the proof file under an
// optional `comments` field (proofs without comments still parse, so
// existing v2 proofs degrade cleanly).

export interface CommentThread {
  id: string;                  // UUID
  rootCommentId: string;
  // Base64-encoded Y.encodeRelativePosition output. Y.RelativePosition pins
  // to a CRDT *item* rather than an absolute index, so the anchor moves with
  // surrounding text under concurrent edits — same state-and-time problem
  // Phase 1 solved for replay, now solved here for review threads.
  anchorStart: string;
  anchorEnd: string;
  resolved: boolean;
  resolvedAt?: string;         // ISO wall-clock
  resolvedBy?: string;         // author thumbprint
  createdAt: string;           // ISO wall-clock
}

export interface Comment {
  id: string;                  // UUID
  threadId: string;
  parentId: string | null;     // null on root; otherwise another Comment.id
  authorThumbprint: string;
  authorHandle: string;        // display metadata; thumbprint is authoritative
  body: string;
  createdAt: string;           // ISO wall-clock
  signature: string;           // ECDSA-P256(base64url) over the canonical-JSON
                               // of {authorThumbprint, threadId, parentId, body, createdAt}
}

// Bundle shape included in the proof file under proof.comments. Both arrays
// in chronological order at write time; the verifier reconstructs ordering
// from createdAt for display.
export interface CommentBundle {
  threads: CommentThread[];
  comments: Comment[];
}
