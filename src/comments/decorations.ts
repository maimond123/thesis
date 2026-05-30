import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import type { CommentStore } from './comment-store';
import type { CommentThread, Comment } from './types';

const PALETTE_SIZE = 6;

// A small deterministic hash so each author's dots and mark color stay stable
// across renders without coordinating with the replay-view's authorIndex map.
function paletteIndex(thumbprint: string): number {
  let h = 0;
  for (let i = 0; i < thumbprint.length; i++) h = (h * 31 + thumbprint.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE_SIZE;
}

const setCommentDecorations = StateEffect.define<DecorationSet>();

const commentField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    // The base mapping handles document edits — that's how a mark anchored to
    // "the quick brown fox" survives someone typing "very " before it.
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCommentDecorations)) next = e.value;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class DotWidget extends WidgetType {
  readonly threadId: string;
  readonly paletteIdx: number;
  readonly title: string;

  constructor(threadId: string, paletteIdx: number, title: string) {
    super();
    this.threadId = threadId;
    this.paletteIdx = paletteIdx;
    this.title = title;
  }

  eq(other: DotWidget): boolean {
    return other.threadId === this.threadId && other.paletteIdx === this.paletteIdx && other.title === this.title;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-comment-dot cm-comment-dot-${this.paletteIdx}`;
    el.title = this.title;
    el.dataset.threadId = this.threadId;
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(commentStore: CommentStore): DecorationSet {
  const items: Array<{ thread: CommentThread; root: Comment | undefined; range: { from: number; to: number } }> = [];
  for (const thread of commentStore.listThreads()) {
    if (thread.resolved) continue; // resolved threads collapse in the side panel and don't decorate the doc
    const range = commentStore.resolveAnchor(thread);
    if (!range) continue;
    const root = commentStore.listComments(thread.id)[0];
    items.push({ thread, root, range });
  }
  // Sort by anchor start, then end — Decoration.set will normalize, but sorting
  // up front keeps the widget→mark ordering predictable when anchors are tight.
  items.sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to);

  const decos: Array<{ from: number; to: number; value: Decoration }> = [];
  for (const { thread, root, range } of items) {
    const pIdx = paletteIndex(root?.authorThumbprint ?? thread.id);
    decos.push({
      from: range.from,
      to: range.to,
      value: Decoration.mark({
        class: `cm-comment-mark cm-comment-mark-${pIdx}`,
        attributes: { 'data-thread-id': thread.id, title: tooltipFor(root, thread) },
      }),
    });
    decos.push({
      from: range.to,
      to: range.to,
      value: Decoration.widget({
        side: 1,
        widget: new DotWidget(thread.id, pIdx, tooltipFor(root, thread)),
      }),
    });
  }
  return Decoration.set(decos.map((d) => d.value.range(d.from, d.to)), /* sort */ true);
}

function tooltipFor(root: Comment | undefined, thread: CommentThread): string {
  if (!root) return 'Comment';
  const preview = root.body.replace(/\s+/g, ' ').trim();
  const head = preview.length > 80 ? `${preview.slice(0, 77)}…` : preview;
  return `${root.authorHandle} • ${new Date(thread.createdAt).toLocaleString()}\n${head}`;
}

export interface CommentDecorationsOptions {
  commentStore: CommentStore;
  onThreadClick: (threadId: string) => void;
}

export function commentDecorationsExtension(opts: CommentDecorationsOptions): Extension {
  const refreshOnStoreChange = ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;
      constructor(view: EditorView) {
        this.unsubscribe = opts.commentStore.onChange(() => {
          view.dispatch({ effects: setCommentDecorations.of(buildDecorations(opts.commentStore)) });
        });
        // Initial population on next tick so the view is ready.
        queueMicrotask(() => {
          view.dispatch({ effects: setCommentDecorations.of(buildDecorations(opts.commentStore)) });
        });
      }
      update(_u: ViewUpdate): void { /* mapping handled by the StateField */ }
      destroy(): void { this.unsubscribe(); }
    },
  );

  const clickHandler = EditorView.domEventHandlers({
    click(event) {
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest('[data-thread-id]');
      const threadId = el instanceof HTMLElement ? el.dataset.threadId : null;
      if (!threadId) return false;
      event.preventDefault();
      opts.onThreadClick(threadId);
      return true;
    },
  });

  return [commentField, refreshOnStoreChange, clickHandler];
}
