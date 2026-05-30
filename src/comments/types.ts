// ─── Comment types ────────────────────────────────────────────────
//
// Comments live in the same Y.Doc as the document text. Two flat Y.Maps
// (one keyed by threadId, one keyed by commentId) provide O(1) lookup and
// avoid the reactivity pitfalls of deeply-nested Yjs structures. Each
// comment is independently ECDSA-signed by its author so authorship is
// provable without entering the keystroke hash chain.

export interface CommentThread {
  id: string;                  // UUID, client-generated
  rootCommentId: string;       // id of the first Comment in this thread
  anchorStart: string;         // base64(Y.encodeRelativePosition) — pins to a CRDT item, not an index, so it survives upstream edits
  anchorEnd: string;
  resolved: boolean;
  resolvedAt?: string;         // ISO wall-clock
  resolvedBy?: string;         // author thumbprint
  createdAt: string;           // ISO wall-clock
}

export interface Comment {
  id: string;                  // UUID, client-generated; NOT covered by signature
  threadId: string;
  parentId: string | null;     // null for the root comment of a thread
  authorThumbprint: string;
  authorHandle: string;        // cached display label — the thumbprint is what verifies
  body: string;
  createdAt: string;           // ISO wall-clock
  signature: string;           // ECDSA-P256 (base64url) over canonicalJson({authorThumbprint, threadId, parentId, body, createdAt})
}

// Shape embedded in a ProofFile under the optional `comments` field. Two flat
// arrays so the proof reader can iterate threads and look up replies by
// threadId without reconstructing the Y.Doc.
export interface CommentsBundle {
  threads: CommentThread[];
  comments: Comment[];
}
