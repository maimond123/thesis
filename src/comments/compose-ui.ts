import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CommentStore } from './comment-store';

// Pill + compose-modal UI for creating new threads. The pill is a small
// floating button anchored above the end of the current selection (mirroring
// Google Docs / GitHub PR review UIs). Clicking it opens a modal anchored to
// the same coordinates with a textarea and Submit / Cancel.
//
// Two implementation details to know:
//   1. The pill swallows mousedown so the editor's selection isn't lost when
//      the user clicks it (same trick as the format-bar buttons).
//   2. The pill is rebuilt from the CodeMirror updateListener whenever the
//      selection changes; a small 200ms debounce avoids flicker while
//      drag-selecting.

export interface ComposeUIOptions {
  commentStore: CommentStore;
  getView: () => EditorView | null;
  onThreadCreated?: () => void; // hook so callers (side panel etc.) can re-render
}

interface SelectionRange {
  from: number;
  to: number;
}

export class ComposeUI {
  private readonly opts: ComposeUIOptions;
  private pillEl: HTMLButtonElement | null = null;
  private modalEl: HTMLDivElement | null = null;
  private currentRange: SelectionRange | null = null;
  private debounceTimer: number | null = null;

  constructor(opts: ComposeUIOptions) {
    this.opts = opts;
  }

  // CodeMirror extension that updates the pill when the selection changes.
  extension(): Extension {
    return EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) return;
      if (this.modalEl) return; // don't disturb an open compose modal
      this.scheduleUpdate(update.view);
    });
  }

  destroy(): void {
    this.clearDebounce();
    this.hidePill();
    this.hideModal();
  }

  // ─── pill ─────────────────────────────────────────────────────────

  private scheduleUpdate(view: EditorView): void {
    this.clearDebounce();
    const sel = view.state.selection.main;
    if (sel.empty) {
      this.hidePill();
      this.currentRange = null;
      return;
    }
    const range: SelectionRange = { from: sel.from, to: sel.to };
    // Debounce so the pill doesn't appear mid-drag.
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.currentRange = range;
      this.showPillFor(view, range);
    }, 200);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private showPillFor(view: EditorView, range: SelectionRange): void {
    const coords = view.coordsAtPos(range.to);
    if (!coords) {
      this.hidePill();
      return;
    }
    if (!this.pillEl) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'comment-pill';
      btn.innerHTML = '<span class="comment-pill-icon">\u{1F4AC}</span><span>Comment</span>';
      // Don't steal focus from the editor — mirrors the format-bar pattern.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (!this.currentRange) return;
        const v = this.opts.getView();
        if (!v) return;
        this.openModal(v, this.currentRange);
      });
      document.body.appendChild(btn);
      this.pillEl = btn;
    }
    // Position: above the end of the selection, nudged right so it doesn't
    // overlap the caret. Use window scroll because coordsAtPos returns
    // viewport coords.
    const top = coords.top + window.scrollY - 38;
    const left = coords.right + window.scrollX + 6;
    this.pillEl.style.top = `${top}px`;
    this.pillEl.style.left = `${left}px`;
    this.pillEl.style.display = 'inline-flex';
  }

  private hidePill(): void {
    if (this.pillEl) this.pillEl.style.display = 'none';
  }

  // ─── modal ────────────────────────────────────────────────────────

  private openModal(view: EditorView, range: SelectionRange): void {
    this.hidePill();
    const coords = view.coordsAtPos(range.to);
    if (!coords) return;

    const modal = document.createElement('div');
    modal.className = 'comment-compose-modal';
    modal.innerHTML = `
      <div class="comment-compose-anchor-preview"></div>
      <textarea class="comment-compose-textarea" placeholder="Add a comment…" rows="3"></textarea>
      <div class="comment-compose-actions">
        <button type="button" class="btn comment-compose-cancel">Cancel</button>
        <button type="button" class="btn btn-primary comment-compose-submit">Comment</button>
      </div>
    `;
    const preview = modal.querySelector<HTMLDivElement>('.comment-compose-anchor-preview')!;
    preview.textContent = this.previewText(view, range);
    const textarea = modal.querySelector<HTMLTextAreaElement>('.comment-compose-textarea')!;
    const cancelBtn = modal.querySelector<HTMLButtonElement>('.comment-compose-cancel')!;
    const submitBtn = modal.querySelector<HTMLButtonElement>('.comment-compose-submit')!;

    // Position below the selection, falling back above if it would go offscreen.
    const top = coords.bottom + window.scrollY + 8;
    const left = Math.max(8, coords.left + window.scrollX);
    modal.style.top = `${top}px`;
    modal.style.left = `${left}px`;

    document.body.appendChild(modal);
    this.modalEl = modal;
    setTimeout(() => textarea.focus(), 0);

    const close = (): void => {
      modal.remove();
      if (this.modalEl === modal) this.modalEl = null;
    };

    cancelBtn.addEventListener('click', close);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });

    const submit = async (): Promise<void> => {
      const body = textarea.value.trim();
      if (!body) {
        textarea.focus();
        return;
      }
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        await this.opts.commentStore.createThread(range, body);
        this.opts.onThreadCreated?.();
        close();
      } catch (err) {
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = 'Comment';
        alert(`Failed to add comment: ${err instanceof Error ? err.message : err}`);
      }
    };

    submitBtn.addEventListener('click', submit);

    // Click outside the modal cancels.
    const outsideClick = (e: MouseEvent): void => {
      if (!this.modalEl) {
        document.removeEventListener('mousedown', outsideClick, true);
        return;
      }
      if (!(e.target instanceof Node) || !this.modalEl.contains(e.target)) {
        document.removeEventListener('mousedown', outsideClick, true);
        close();
      }
    };
    // defer to next tick so the click that opened the modal doesn't immediately close it
    setTimeout(() => document.addEventListener('mousedown', outsideClick, true), 0);
  }

  private hideModal(): void {
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
  }

  private previewText(view: EditorView, range: SelectionRange): string {
    const raw = view.state.doc.sliceString(range.from, range.to);
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 60) return collapsed;
    return `${collapsed.slice(0, 57)}…`;
  }
}
