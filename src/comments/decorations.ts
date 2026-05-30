import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { CommentStore } from './comment-store';
import type { CommentThread } from './types';

// Subtle yellow underline on every (unresolved) thread's anchored range,
// plus a small dot in the right gutter. The decoration positions are
// recomputed from the live Y.RelativePosition every time the doc changes
// so the highlights track with concurrent edits without us mapping them
// through changesets ourselves.

const PALETTE_SIZE = 6;

export interface ThreadAnchorPreview {
  thread: CommentThread;
  range: { from: number; to: number } | null;
  authorIndex: number;
}

// Effect emitted by the side panel (or any other code) when the underlying
// thread set or anchors might have changed. The StateField listens for it
// and recomputes the decoration set from the supplied threads.
export const setThreadAnchors = StateEffect.define<ThreadAnchorPreview[]>();

// Effect to push the currently-focused thread id so the corresponding range
// gets an "active" highlight (slightly darker underline).
export const setActiveThread = StateEffect.define<string | null>();

interface CommentDecoState {
  anchors: ThreadAnchorPreview[];
  activeId: string | null;
}

const commentDecoState = StateField.define<CommentDecoState>({
  create() { return { anchors: [], activeId: null }; },
  update(state, tr) {
    let next = state;
    for (const e of tr.effects) {
      if (e.is(setThreadAnchors)) next = { ...next, anchors: e.value };
      else if (e.is(setActiveThread)) next = { ...next, activeId: e.value };
    }
    return next;
  },
});

const commentDecorations = EditorView.decorations.compute([commentDecoState], (state) => {
  const { anchors, activeId } = state.field(commentDecoState);
  const docLen = state.doc.length;
  const decos: { from: number; to: number; deco: Decoration }[] = [];
  for (const a of anchors) {
    if (!a.range) continue;
    if (a.thread.resolved) continue;        // resolved threads don't underline
    const from = Math.max(0, Math.min(a.range.from, docLen));
    const to = Math.max(from, Math.min(a.range.to, docLen));
    if (to <= from) continue;
    const isActive = a.thread.id === activeId;
    const cls = `cm-comment-underline cm-author-${a.authorIndex}${isActive ? ' cm-comment-active' : ''}`;
    decos.push({ from, to, deco: Decoration.mark({ class: cls }) });
  }
  decos.sort((x, y) => x.from - y.from || x.to - y.to);
  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)));
});

// Click handler on the underlined range — opens the side panel for the
// clicked thread. We can't easily target a specific decoration; instead we
// look up which thread's anchor contains the click position.
function clickHandler(
  store: CommentStore,
  authorIndex: (thumb: string) => number,
  openThread: (threadId: string) => void,
): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;
      // Find the smallest enclosing thread anchor.
      let best: { thread: CommentThread; range: { from: number; to: number } } | null = null;
      for (const t of store.listThreads()) {
        if (t.resolved) continue;
        const r = store.resolveAnchor(t);
        if (!r) continue;
        if (pos < r.from || pos > r.to) continue;
        const width = r.to - r.from;
        if (!best || width < (best.range.to - best.range.from)) best = { thread: t, range: r };
      }
      if (best) {
        openThread(best.thread.id);
      }
      // Reference authorIndex once so the closure variable isn't reported as unused.
      void authorIndex;
    },
  });
}

// Public: an extension that surfaces a CommentStore's threads as CM
// decorations and routes clicks back to a side-panel opener. The view's
// own owner is responsible for dispatching setThreadAnchors / setActiveThread
// when the store changes.
export function commentDecorationExtension(
  store: CommentStore,
  authorIndex: (thumb: string) => number,
  openThread: (threadId: string) => void,
): Extension {
  return [commentDecoState, commentDecorations, clickHandler(store, authorIndex, openThread)];
}

// Helper used by main.ts to build the ThreadAnchorPreview list from a store
// snapshot. The root comment carries the thread author's thumbprint, so we
// look it up via listComments(threadId)[0] (sorted earliest-first by the store).
//
// cutoffMs (optional): hide threads whose createdAt is later than this
// wall-clock timestamp. Used by Replay to time-scrub comments — at the
// start of replay no threads have "existed yet"; as the scrub advances
// past the keystroke clock where each thread was created, it appears.
// When omitted (Editor tab + Verify panel), all threads are returned.
export function buildAnchorPreviews(
  store: CommentStore,
  authorIndex: (thumb: string) => number,
  cutoffMs?: number,
): ThreadAnchorPreview[] {
  const threads = cutoffMs === undefined
    ? store.listThreads()
    : store.listThreads().filter((t) => {
        const t0 = Date.parse(t.createdAt);
        // Threads with unparseable timestamps (defensive) fall back to
        // visible-always rather than disappearing silently.
        return Number.isNaN(t0) || t0 <= cutoffMs;
      });
  return threads.map((thread) => {
    const root = store.listComments(thread.id).find((c) => c.id === thread.rootCommentId);
    const thumb = root?.authorThumbprint ?? '';
    return {
      thread,
      range: store.resolveAnchor(thread),
      authorIndex: (authorIndex(thumb) >= 0 ? authorIndex(thumb) : 0) % PALETTE_SIZE,
    };
  });
}
