import * as Y from 'yjs';
import type { CommentStore } from './comment-store';
import type { CommentThread, Comment } from './types';

// Right-docked panel listing all threads. Open threads sit at the top expanded
// with their reply box; resolved threads sit at the bottom collapsed under a
// divider. The panel re-renders whenever the underlying Y.Maps change.

export interface SidePanelOptions {
  commentStore: CommentStore;
  ydoc: Y.Doc;
  // Called when the user clicks an anchor preview; the editor should select
  // the anchored range. Wired in C.6 alongside the gutter decorations.
  onAnchorClick?: (thread: CommentThread, range: { from: number; to: number } | null) => void;
}

export class CommentSidePanel {
  private readonly opts: SidePanelOptions;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly headerCount: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private expandedThreadId: string | null = null;
  private showResolved = false;

  constructor(parent: HTMLElement, opts: SidePanelOptions) {
    this.opts = opts;

    this.root = document.createElement('aside');
    this.root.className = 'comments-panel';
    this.root.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'comments-panel-header';
    const title = document.createElement('span');
    title.className = 'comments-panel-title';
    title.textContent = 'Comments';
    this.headerCount = document.createElement('span');
    this.headerCount.className = 'comments-panel-count';
    header.appendChild(title);
    header.appendChild(this.headerCount);
    this.root.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'comments-panel-body';
    this.root.appendChild(this.body);

    parent.appendChild(this.root);

    this.unsubscribe = this.opts.commentStore.onChange(() => this.render());
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(threadId?: string): void {
    if (threadId) this.expandedThreadId = threadId;
    this.root.style.display = 'flex';
    this.render();
    if (threadId) this.scrollThreadIntoView(threadId);
  }

  close(): void {
    this.root.style.display = 'none';
  }

  isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  destroy(): void {
    this.unsubscribe?.();
    this.root.remove();
  }

  // ─── render ──────────────────────────────────────────────────────

  private render(): void {
    const all = this.opts.commentStore.listThreads();
    const open = all.filter((t) => !t.resolved);
    const resolved = all.filter((t) => t.resolved);

    this.headerCount.textContent = open.length === 0
      ? 'no open threads'
      : `${open.length} open${resolved.length > 0 ? ` · ${resolved.length} resolved` : ''}`;

    this.body.innerHTML = '';

    if (open.length === 0 && resolved.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = 'No comments yet. Select text in the editor and click the Comment pill to start a thread.';
      this.body.appendChild(empty);
      return;
    }

    for (const t of open) this.body.appendChild(this.renderThread(t));

    if (resolved.length > 0) {
      const divider = document.createElement('button');
      divider.type = 'button';
      divider.className = 'comments-divider';
      divider.textContent = this.showResolved
        ? `Hide resolved (${resolved.length})`
        : `Show resolved (${resolved.length})`;
      divider.addEventListener('click', () => {
        this.showResolved = !this.showResolved;
        this.render();
      });
      this.body.appendChild(divider);
      if (this.showResolved) {
        for (const t of resolved) this.body.appendChild(this.renderThread(t));
      }
    }
  }

  private renderThread(thread: CommentThread): HTMLElement {
    const card = document.createElement('div');
    card.className = 'comment-thread' + (thread.resolved ? ' resolved' : '');
    card.dataset.threadId = thread.id;
    if (this.expandedThreadId === thread.id) card.classList.add('expanded');

    const anchor = document.createElement('div');
    anchor.className = 'comment-thread-anchor';
    const range = this.opts.commentStore.resolveAnchor(thread);
    if (range) {
      const preview = this.previewFromAnchor(range);
      anchor.textContent = preview || '(empty anchor)';
      anchor.title = 'Click to jump to this range in the document';
      anchor.addEventListener('click', () => {
        this.opts.onAnchorClick?.(thread, range);
      });
    } else {
      anchor.textContent = '(anchored text deleted)';
      anchor.classList.add('deleted');
    }
    card.appendChild(anchor);

    const comments = this.opts.commentStore.listComments(thread.id);
    const root = comments[0];
    const replies = comments.slice(1);

    if (root) card.appendChild(this.renderComment(root, /* isRoot */ true));

    if (this.expandedThreadId === thread.id) {
      for (const r of replies) card.appendChild(this.renderComment(r, false));
      card.appendChild(this.renderReplyForm(thread));
    } else if (replies.length > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'comment-thread-more';
      more.textContent = `+ ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`;
      more.addEventListener('click', () => {
        this.expandedThreadId = thread.id;
        this.render();
      });
      card.appendChild(more);
    } else if (!thread.resolved) {
      // Open thread with no replies — single "Reply" affordance.
      const reply = document.createElement('button');
      reply.type = 'button';
      reply.className = 'comment-thread-more';
      reply.textContent = 'Reply';
      reply.addEventListener('click', () => {
        this.expandedThreadId = thread.id;
        this.render();
      });
      card.appendChild(reply);
    }

    if (this.expandedThreadId === thread.id) {
      const actions = document.createElement('div');
      actions.className = 'comment-thread-actions';
      const resolve = document.createElement('button');
      resolve.type = 'button';
      resolve.className = 'btn';
      resolve.textContent = thread.resolved ? 'Reopen' : 'Resolve';
      resolve.addEventListener('click', () => {
        if (thread.resolved) this.opts.commentStore.unresolveThread(thread.id);
        else this.opts.commentStore.resolveThread(thread.id);
      });
      actions.appendChild(resolve);
      card.appendChild(actions);
    }

    // Collapse on whitespace click (not when clicking interactive children).
    card.addEventListener('click', (e) => {
      if (e.target !== card) return;
      this.expandedThreadId = this.expandedThreadId === thread.id ? null : thread.id;
      this.render();
    });

    return card;
  }

  private renderComment(comment: Comment, isRoot: boolean): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'comment-card' + (isRoot ? ' root' : '');

    const head = document.createElement('div');
    head.className = 'comment-card-head';
    const author = document.createElement('span');
    author.className = 'comment-card-author';
    author.textContent = comment.authorHandle;
    const time = document.createElement('span');
    time.className = 'comment-card-time';
    time.textContent = relativeTime(comment.createdAt);
    time.title = new Date(comment.createdAt).toLocaleString();
    head.appendChild(author);
    head.appendChild(time);

    const body = document.createElement('div');
    body.className = 'comment-card-body';
    body.textContent = comment.body;

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  private renderReplyForm(thread: CommentThread): HTMLElement {
    const form = document.createElement('div');
    form.className = 'comment-reply-form';
    const ta = document.createElement('textarea');
    ta.className = 'comment-reply-textarea';
    ta.placeholder = thread.resolved ? 'Reopen to reply' : 'Reply…';
    ta.rows = 2;
    ta.disabled = thread.resolved;
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-primary';
    send.textContent = 'Reply';
    send.disabled = thread.resolved;

    const submit = async (): Promise<void> => {
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      try {
        await this.opts.commentStore.reply(thread.id, body);
        ta.value = '';
      } catch (err) {
        alert(`Reply failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        send.disabled = false;
      }
    };

    send.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });

    form.appendChild(ta);
    form.appendChild(send);
    return form;
  }

  private scrollThreadIntoView(threadId: string): void {
    const el = this.body.querySelector(`[data-thread-id="${threadId}"]`);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }

  // Use the live Y.Text so we always read the current document content for the
  // anchor preview — the snapshot stored in `thread` is just CRDT coordinates.
  private previewFromAnchor(range: { from: number; to: number }): string {
    const yText = this.opts.ydoc.getText('main');
    const slice = yText.toString().slice(range.from, range.to);
    const collapsed = slice.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 40) return collapsed;
    return `${collapsed.slice(0, 37)}…`;
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.round((now - then) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
