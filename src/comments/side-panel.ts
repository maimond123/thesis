import type { CommentStore } from './comment-store';
import type { CommentThread, Comment } from './types';
import type { IdentityStore } from '../identity/identity-store';

// Right-docked side panel that lists every thread in the doc. Each row
// shows the anchor preview text, the root author + handle, the body
// snippet, and reply count. Clicking the row expands the thread inline
// with the full reply list + a reply textarea + a resolve/unresolve
// button. Resolved threads collapse under a separator at the bottom.
//
// The panel does NOT own the thread state — every render reads from the
// CommentStore directly. CommentStore.onChange triggers a re-render on
// any Y.Map mutation, so concurrent edits from peers update the panel
// automatically.

export interface CommentsSidePanel {
  open(threadId?: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
  // Force a re-render without changing open/closed state. Called when the
  // store fires onChange.
  render(): void;
}

export function mountCommentsSidePanel(
  parent: HTMLElement,
  store: CommentStore,
  identity: IdentityStore,
  // Get the anchored range from the live Y.Text so we can preview the text
  // currently under the anchor (changes as the doc is edited).
  getTextSnippet: (range: { from: number; to: number }) => string,
  onActiveThreadChange: (threadId: string | null) => void,
  // For "scroll the editor to this thread" when the user clicks an anchor preview.
  scrollToRange: (range: { from: number; to: number }) => void,
): CommentsSidePanel {
  const panel = document.createElement('aside');
  panel.className = 'comments-side-panel';
  panel.innerHTML = `
    <div class="comments-side-head">
      <span class="comments-side-title">Comments</span>
      <button type="button" class="comments-side-close" aria-label="Close">×</button>
    </div>
    <div class="comments-side-body"></div>
  `;
  parent.appendChild(panel);
  const body = panel.querySelector<HTMLDivElement>('.comments-side-body')!;

  let expandedId: string | null = null;
  let isShown = false;

  panel.querySelector<HTMLButtonElement>('.comments-side-close')!.addEventListener('click', () => api.close());

  function setExpanded(id: string | null) {
    expandedId = id;
    onActiveThreadChange(id);
    render();
  }

  function render() {
    if (!isShown) return;
    const threads = store.listThreads();
    if (threads.length === 0) {
      body.innerHTML = '<div class="comments-empty">No comments yet. Select text in the Editor to add one.</div>';
      return;
    }
    const open = threads.filter((t) => !t.resolved);
    const resolved = threads.filter((t) => t.resolved);
    body.innerHTML = '';
    for (const t of open) body.appendChild(renderThread(t));
    if (resolved.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'comments-resolved-sep';
      sep.textContent = `Resolved (${resolved.length})`;
      body.appendChild(sep);
      for (const t of resolved) body.appendChild(renderThread(t));
    }
  }

  function renderThread(thread: CommentThread): HTMLElement {
    const comments = store.listComments(thread.id);
    const root = comments.find((c) => c.id === thread.rootCommentId);
    if (!root) {
      const broken = document.createElement('div');
      broken.className = 'comments-thread broken';
      broken.textContent = `Thread ${thread.id.slice(0, 8)} missing root comment`;
      return broken;
    }
    const replies = comments.filter((c) => c.id !== root.id);
    const range = store.resolveAnchor(thread);
    const snippet = range ? getTextSnippet(range) : null;
    const expanded = expandedId === thread.id;

    const el = document.createElement('div');
    el.className = `comments-thread${expanded ? ' expanded' : ''}${thread.resolved ? ' resolved' : ''}`;

    const anchorPreview = document.createElement('button');
    anchorPreview.type = 'button';
    anchorPreview.className = 'comments-anchor-preview';
    anchorPreview.textContent = snippet === null ? '(anchored text deleted)' : snippet;
    anchorPreview.title = snippet === null ? '' : 'Click to scroll the editor to this range';
    anchorPreview.addEventListener('click', (e) => {
      e.stopPropagation();
      if (range) scrollToRange(range);
      setExpanded(thread.id);
    });
    el.appendChild(anchorPreview);

    el.appendChild(renderComment(root));

    if (expanded || replies.length > 0) {
      const repliesEl = document.createElement('div');
      repliesEl.className = 'comments-replies';
      for (const r of replies) repliesEl.appendChild(renderComment(r));
      el.appendChild(repliesEl);
    }

    if (expanded) {
      const composer = document.createElement('div');
      composer.className = 'comments-reply-composer';
      composer.innerHTML = `
        <textarea class="comments-reply-text" placeholder="Reply..." rows="2"></textarea>
        <div class="comments-reply-actions">
          <button type="button" class="btn ${thread.resolved ? '' : 'btn-primary'} comments-reply-submit">Reply</button>
          <button type="button" class="btn comments-resolve-toggle">${thread.resolved ? 'Reopen' : 'Resolve'}</button>
        </div>
      `;
      const ta = composer.querySelector<HTMLTextAreaElement>('.comments-reply-text')!;
      composer.querySelector<HTMLButtonElement>('.comments-reply-submit')!.addEventListener('click', async () => {
        const body = ta.value.trim();
        if (!body) { ta.focus(); return; }
        try {
          await store.reply(thread.id, body);
          ta.value = '';
        } catch (err) {
          alert(`Couldn't post reply: ${err}`);
        }
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          composer.querySelector<HTMLButtonElement>('.comments-reply-submit')!.click();
        } else if (e.key === 'Escape') {
          setExpanded(null);
        }
      });
      composer.querySelector<HTMLButtonElement>('.comments-resolve-toggle')!.addEventListener('click', () => {
        if (thread.resolved) store.unresolveThread(thread.id);
        else store.resolveThread(thread.id);
      });
      el.appendChild(composer);
    }

    // Click anywhere on the row collapses other expansions and opens this one.
    el.addEventListener('click', () => {
      if (!expanded) setExpanded(thread.id);
    });

    // "Mine" badge if this thread belongs to the local user.
    if (root.authorThumbprint === identity.getSelf().thumbprint) {
      el.classList.add('comments-mine');
    }

    return el;
  }

  function renderComment(c: Comment): HTMLElement {
    const el = document.createElement('div');
    el.className = 'comments-comment';
    const wall = new Date(c.createdAt).toLocaleString();
    el.innerHTML = `
      <div class="comments-comment-head">
        <span class="comments-handle">${escapeHtml(c.authorHandle)}</span>
        <span class="comments-time" title="${escapeHtml(c.createdAt)}">${escapeHtml(wall)}</span>
      </div>
      <div class="comments-body">${escapeHtml(c.body).replace(/\n/g, '<br>')}</div>
    `;
    return el;
  }

  store.onChange(render);

  const api: CommentsSidePanel = {
    open(threadId) {
      isShown = true;
      panel.classList.add('open');
      if (threadId) setExpanded(threadId);
      else render();
    },
    close() {
      isShown = false;
      panel.classList.remove('open');
      setExpanded(null);
    },
    toggle() {
      if (isShown) api.close(); else api.open();
    },
    isOpen() { return isShown; },
    destroy() {
      panel.remove();
    },
    render,
  };
  return api;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
