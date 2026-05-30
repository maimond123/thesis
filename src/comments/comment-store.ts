import * as Y from 'yjs';
import type { IdentityStore } from '../identity/identity-store';
import { bytesToBase64, base64ToBytes } from '../editor/yjs-bytes';
import { canonicalJsonStringify } from '../crypto/hash-chain';
import type { CommentThread, Comment, CommentsBundle } from './types';

const THREADS_KEY = 'comment-threads';
const COMMENTS_KEY = 'comments';

// Wrapper around two Y.Maps in the host Y.Doc. Threads and comments are
// stored as plain-object values keyed by UUID; the foreign key (comment.threadId)
// ties replies to their thread. Anchors are kept as base64-encoded Yjs
// RelativePositions so they migrate with the surrounding text as peers edit
// concurrently.
//
// Why plain objects rather than nested Y.Maps for each record: every field
// either is immutable (comments) or mutates as an atomic batch (resolve sets
// resolved/resolvedAt/resolvedBy together). Field-level CRDT on the inner
// record buys nothing here, and plain objects make persistence + proof-file
// serialization trivial.
export class CommentStore {
  private readonly ydoc: Y.Doc;
  private readonly yText: Y.Text;
  private readonly identity: IdentityStore;
  private readonly threads: Y.Map<CommentThread>;
  private readonly comments: Y.Map<Comment>;
  private readonly listeners: Set<() => void> = new Set();

  constructor(ydoc: Y.Doc, yText: Y.Text, identity: IdentityStore) {
    this.ydoc = ydoc;
    this.yText = yText;
    this.identity = identity;
    this.threads = ydoc.getMap<CommentThread>(THREADS_KEY);
    this.comments = ydoc.getMap<Comment>(COMMENTS_KEY);

    const fire = (): void => { for (const cb of this.listeners) cb(); };
    this.threads.observe(fire);
    this.comments.observe(fire);
  }

  async createThread(range: { from: number; to: number }, body: string): Promise<CommentThread> {
    if (range.to <= range.from) throw new Error('CommentStore.createThread: empty range');
    if (!body.trim()) throw new Error('CommentStore.createThread: empty body');

    const self = this.identity.getSelf();
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const signature = await this.signCommentFields({
      authorThumbprint: self.thumbprint,
      threadId,
      parentId: null,
      body,
      createdAt,
    });

    const thread: CommentThread = {
      id: threadId,
      rootCommentId: commentId,
      anchorStart: this.encodeAnchor(range.from),
      anchorEnd: this.encodeAnchor(range.to),
      resolved: false,
      createdAt,
    };
    const rootComment: Comment = {
      id: commentId,
      threadId,
      parentId: null,
      authorThumbprint: self.thumbprint,
      authorHandle: self.handle,
      body,
      createdAt,
      signature,
    };

    this.ydoc.transact(() => {
      this.threads.set(threadId, thread);
      this.comments.set(commentId, rootComment);
    });
    return thread;
  }

  async reply(threadId: string, body: string): Promise<Comment> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`CommentStore.reply: unknown threadId ${threadId}`);
    if (!body.trim()) throw new Error('CommentStore.reply: empty body');

    const self = this.identity.getSelf();
    const commentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const parentId = this.latestCommentId(threadId) ?? thread.rootCommentId;

    const signature = await this.signCommentFields({
      authorThumbprint: self.thumbprint,
      threadId,
      parentId,
      body,
      createdAt,
    });

    const comment: Comment = {
      id: commentId,
      threadId,
      parentId,
      authorThumbprint: self.thumbprint,
      authorHandle: self.handle,
      body,
      createdAt,
      signature,
    };

    this.comments.set(commentId, comment);
    return comment;
  }

  resolveThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.resolved) return;
    const self = this.identity.getSelf();
    this.threads.set(threadId, {
      ...thread,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy: self.thumbprint,
    });
  }

  unresolveThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || !thread.resolved) return;
    const next: CommentThread = { ...thread, resolved: false };
    delete next.resolvedAt;
    delete next.resolvedBy;
    this.threads.set(threadId, next);
  }

  listThreads(): CommentThread[] {
    return Array.from(this.threads.values()).sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  listComments(threadId: string): Comment[] {
    const out: Comment[] = [];
    for (const c of this.comments.values()) {
      if (c.threadId === threadId) out.push(c);
    }
    return out.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  // Resolve a thread's anchor to an absolute range in the current Y.Text.
  // Returns null when the original range no longer maps to live text — either
  // the anchored item is unreachable or the range collapsed to zero because
  // the text was deleted. Callers should render that as "(anchored text deleted)".
  resolveAnchor(thread: CommentThread): { from: number; to: number } | null {
    const startRel = Y.decodeRelativePosition(base64ToBytes(thread.anchorStart));
    const endRel = Y.decodeRelativePosition(base64ToBytes(thread.anchorEnd));
    const start = Y.createAbsolutePositionFromRelativePosition(startRel, this.ydoc);
    const end = Y.createAbsolutePositionFromRelativePosition(endRel, this.ydoc);
    if (!start || !end) return null;
    if (end.index <= start.index) return null;
    return { from: start.index, to: end.index };
  }

  // Re-hydrate from a saved bundle (recovery or proof import). Overwrites
  // anything currently in the maps for matching ids; preserves other entries.
  loadFromBundle(bundle: CommentsBundle | undefined): void {
    if (!bundle) return;
    this.ydoc.transact(() => {
      for (const t of bundle.threads) this.threads.set(t.id, t);
      for (const c of bundle.comments) this.comments.set(c.id, c);
    });
  }

  toBundle(): CommentsBundle {
    return {
      threads: this.listThreads(),
      comments: Array.from(this.comments.values()).sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      }),
    };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ─── internal helpers ────────────────────────────────────────────

  private encodeAnchor(pos: number): string {
    const rel = Y.createRelativePositionFromTypeIndex(this.yText, pos);
    return bytesToBase64(Y.encodeRelativePosition(rel));
  }

  private async signCommentFields(fields: {
    authorThumbprint: string;
    threadId: string;
    parentId: string | null;
    body: string;
    createdAt: string;
  }): Promise<string> {
    const payload = canonicalJsonStringify({
      authorThumbprint: fields.authorThumbprint,
      threadId: fields.threadId,
      parentId: fields.parentId,
      body: fields.body,
      createdAt: fields.createdAt,
    });
    return this.identity.signWithSelf(payload);
  }

  private latestCommentId(threadId: string): string | null {
    const replies = this.listComments(threadId);
    return replies.length > 0 ? replies[replies.length - 1].id : null;
  }
}
