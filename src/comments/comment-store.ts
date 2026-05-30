import * as Y from 'yjs';
import type { CommentThread, Comment, CommentBundle } from './types';
import { commentSigningPayload, verifyComment } from './comment-signing';
import { bytesToBase64, base64ToBytes } from '../editor/yjs-bytes';
import type { IdentityStore } from '../identity/identity-store';

const THREADS_KEY = 'comment-threads';
const COMMENTS_KEY = 'comments';

// Wraps the two Y.Maps that hold review activity. Threads and comments are
// stored as plain JS objects (Yjs allows nested-shape values inside a Y.Map);
// mutation = re-set the whole object. This is "flat keyed by id" rather
// than "deeply nested Y.Map" because Yjs nesting reactivity is finicky and
// the JSON-value model survives import/export trivially.
export class CommentStore {
  private readonly ydoc: Y.Doc;
  private readonly yText: Y.Text;
  // Identity is required for write operations (createThread, reply, resolve)
  // since those produce signed payloads, but read-only consumers (the Replay
  // tab loading a proof bundle for display) don't need one. Setting it to
  // null gives a read-only store; mutation methods throw if called against it.
  private readonly identity: IdentityStore | null;
  private threadsMap: Y.Map<CommentThread>;
  private commentsMap: Y.Map<Comment>;
  private changeListeners: Set<() => void> = new Set();

  constructor(ydoc: Y.Doc, yText: Y.Text, identity: IdentityStore | null) {
    this.ydoc = ydoc;
    this.yText = yText;
    this.identity = identity;
    this.threadsMap = ydoc.getMap<CommentThread>(THREADS_KEY);
    this.commentsMap = ydoc.getMap<Comment>(COMMENTS_KEY);

    const fire = () => this.changeListeners.forEach((cb) => cb());
    this.threadsMap.observe(fire);
    this.commentsMap.observe(fire);
  }

  // Throws if called on a read-only store (constructed with identity=null).
  private requireIdentity(method: string): IdentityStore {
    if (!this.identity) throw new Error(`CommentStore.${method} requires an identity; this store is read-only`);
    return this.identity;
  }

  // Create a new thread anchored at [from, to). Atomic: thread + root comment
  // both inserted in a single ydoc.transact so peers see them appear together.
  // Returns the resulting thread (with anchors encoded) so the caller can
  // immediately scroll/open it.
  async createThread(range: { from: number; to: number }, body: string): Promise<CommentThread> {
    if (range.from > range.to) throw new Error('range.from must be <= range.to');
    if (!body.trim()) throw new Error('Empty comment body');

    const identity = this.requireIdentity('createThread');
    const self = identity.getSelf();
    const threadId = crypto.randomUUID();
    const rootCommentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const relStart = Y.createRelativePositionFromTypeIndex(this.yText, range.from);
    const relEnd = Y.createRelativePositionFromTypeIndex(this.yText, range.to);
    const anchorStart = bytesToBase64(Y.encodeRelativePosition(relStart));
    const anchorEnd = bytesToBase64(Y.encodeRelativePosition(relEnd));

    const rootComment: Comment = {
      id: rootCommentId,
      threadId,
      parentId: null,
      authorThumbprint: self.thumbprint,
      authorHandle: self.handle,
      body: body.trim(),
      createdAt,
      signature: '', // filled after signing
    };
    rootComment.signature = await identity.signWithSelf(commentSigningPayload(rootComment));

    const thread: CommentThread = {
      id: threadId,
      rootCommentId,
      anchorStart,
      anchorEnd,
      resolved: false,
      createdAt,
    };

    this.ydoc.transact(() => {
      this.threadsMap.set(threadId, thread);
      this.commentsMap.set(rootCommentId, rootComment);
    });

    return thread;
  }

  // Reply to an existing thread. parentId points to the comment being
  // replied to; for a top-level reply this is the root comment id, for a
  // nested reply it's the parent reply id.
  async reply(threadId: string, body: string, parentId?: string): Promise<Comment> {
    if (!body.trim()) throw new Error('Empty comment body');
    const thread = this.threadsMap.get(threadId);
    if (!thread) throw new Error(`No such thread: ${threadId}`);

    const identity = this.requireIdentity('reply');
    const self = identity.getSelf();
    const commentId = crypto.randomUUID();
    const comment: Comment = {
      id: commentId,
      threadId,
      parentId: parentId ?? thread.rootCommentId,
      authorThumbprint: self.thumbprint,
      authorHandle: self.handle,
      body: body.trim(),
      createdAt: new Date().toISOString(),
      signature: '',
    };
    comment.signature = await identity.signWithSelf(commentSigningPayload(comment));

    this.commentsMap.set(commentId, comment);
    return comment;
  }

  resolveThread(threadId: string): void {
    const thread = this.threadsMap.get(threadId);
    if (!thread || thread.resolved) return;
    const identity = this.requireIdentity('resolveThread');
    const self = identity.getSelf();
    this.threadsMap.set(threadId, {
      ...thread,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy: self.thumbprint,
    });
  }

  unresolveThread(threadId: string): void {
    const thread = this.threadsMap.get(threadId);
    if (!thread || !thread.resolved) return;
    const next: CommentThread = { ...thread, resolved: false };
    delete next.resolvedAt;
    delete next.resolvedBy;
    this.threadsMap.set(threadId, next);
  }

  // Delete a thread + all its comments. Hard delete; this is review activity,
  // not authorship — losing a thread doesn't break any tamper-evidence.
  // Useful when an author wants to retract a comment they made.
  deleteThread(threadId: string): void {
    const comments = this.listComments(threadId);
    this.ydoc.transact(() => {
      this.threadsMap.delete(threadId);
      for (const c of comments) this.commentsMap.delete(c.id);
    });
  }

  listThreads(): CommentThread[] {
    return Array.from(this.threadsMap.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  }

  listComments(threadId: string): Comment[] {
    return Array.from(this.commentsMap.values())
      .filter((c) => c.threadId === threadId)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        // Stable tie-break on id so concurrent replies still order deterministically.
        return a.id < b.id ? -1 : 1;
      });
  }

  getThread(threadId: string): CommentThread | undefined {
    return this.threadsMap.get(threadId);
  }

  // Resolve a thread's relative-position anchor back to absolute indices in
  // the current Y.Text. Returns null when EITHER endpoint cannot be resolved —
  // happens when the anchored CRDT item has been fully removed from the doc
  // (caller renders "anchored text deleted"). For a tombstoned position
  // Yjs returns the closest live position, which is good enough for "this
  // comment was on a deleted range" UX.
  resolveAnchor(thread: CommentThread): { from: number; to: number } | null {
    try {
      const relStart = Y.decodeRelativePosition(base64ToBytes(thread.anchorStart));
      const relEnd = Y.decodeRelativePosition(base64ToBytes(thread.anchorEnd));
      const absStart = Y.createAbsolutePositionFromRelativePosition(relStart, this.ydoc);
      const absEnd = Y.createAbsolutePositionFromRelativePosition(relEnd, this.ydoc);
      if (!absStart || !absEnd) return null;
      if (absStart.type !== this.yText || absEnd.type !== this.yText) return null;
      return { from: absStart.index, to: absEnd.index };
    } catch {
      return null;
    }
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  // Snapshot the current state to a plain object for persistence + export.
  snapshot(): CommentBundle {
    return {
      threads: this.listThreads(),
      comments: Array.from(this.commentsMap.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      ),
    };
  }

  // Load a snapshot into the live Y.Maps. Used by recovery to rehydrate
  // comments alongside the keystroke chain. Overwrites any existing entries
  // with the same id (caller decides whether to clear first).
  load(bundle: CommentBundle | undefined): void {
    if (!bundle) return;
    this.ydoc.transact(() => {
      for (const t of bundle.threads) this.threadsMap.set(t.id, t);
      for (const c of bundle.comments) this.commentsMap.set(c.id, c);
    });
  }

  // Verify every comment's signature against the supplied roster (map from
  // thumbprint to public key). Returns per-comment results so the verifier
  // UI can flag specific failures.
  async verifyAll(roster: Map<string, JsonWebKey>): Promise<Array<{ comment: Comment; valid: boolean }>> {
    const results: Array<{ comment: Comment; valid: boolean }> = [];
    for (const c of this.commentsMap.values()) {
      const pk = roster.get(c.authorThumbprint);
      if (!pk) { results.push({ comment: c, valid: false }); continue; }
      const ok = await verifyComment(c, pk);
      results.push({ comment: c, valid: ok });
    }
    return results;
  }
}
