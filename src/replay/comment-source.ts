import * as Y from 'yjs';
import { base64ToBytes } from '../editor/yjs-bytes';
import type { CommentDataSource } from '../comments/decorations';
import type { CommentThread, Comment } from '../comments/types';

// Read-only data source for the Replay surface. Wraps the static threads and
// comments from a ProofFile, and resolves anchors against the replay's live
// Y.Doc — that ydoc is rebuilt event-by-event during replay, so the anchors
// only resolve once the keystrokes that created their anchored text have been
// applied. That's intentional: a comment whose anchored text doesn't exist
// yet in the replay timeline simply doesn't decorate anything.
export class ProofCommentSource implements CommentDataSource {
  private readonly ydoc: Y.Doc;
  private readonly threads: CommentThread[];
  private readonly comments: Comment[];
  private readonly listeners: Set<() => void> = new Set();
  private readonly updateHandler: () => void;

  constructor(
    ydoc: Y.Doc,
    threads: CommentThread[],
    comments: Comment[],
  ) {
    this.ydoc = ydoc;
    this.threads = threads;
    this.comments = comments;
    this.updateHandler = (): void => {
      for (const cb of this.listeners) cb();
    };
    // Re-emit onChange whenever the replay surface's Y.Doc evolves. The
    // decoration extension re-runs resolveAnchor on every notification, so
    // anchors light up as the replay reaches the keystrokes that created
    // them.
    this.ydoc.on('updateV2', this.updateHandler);
  }

  listThreads(): CommentThread[] {
    return this.threads.slice().sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  listComments(threadId: string): Comment[] {
    return this.comments
      .filter((c) => c.threadId === threadId)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
  }

  resolveAnchor(thread: CommentThread): { from: number; to: number } | null {
    try {
      const startRel = Y.decodeRelativePosition(base64ToBytes(thread.anchorStart));
      const endRel = Y.decodeRelativePosition(base64ToBytes(thread.anchorEnd));
      const start = Y.createAbsolutePositionFromRelativePosition(startRel, this.ydoc);
      const end = Y.createAbsolutePositionFromRelativePosition(endRel, this.ydoc);
      if (!start || !end) return null;
      if (end.index <= start.index) return null;
      return { from: start.index, to: end.index };
    } catch {
      return null;
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  destroy(): void {
    this.ydoc.off('updateV2', this.updateHandler);
    this.listeners.clear();
  }
}
