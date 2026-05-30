import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { CommentStore } from './comment-store';

// Floating "Comment" pill that appears just above a non-empty selection
// after it stays put for 200ms, and a compose modal that pops up when
// clicked. The pill stays out of the way of keystrokes (it lives in a
// portal element appended to body, not inside the editor's DOM).

const STAY_DELAY_MS = 200;

export interface PendingSelection {
  from: number;
  to: number;
}

export interface ComposeController {
  // Called by composeUpdateListener (below) every time the selection state
  // changes. Passing null hides the pill; passing a range shows it.
  onSelectionChange(sel: PendingSelection | null): void;
  destroy(): void;
}

// Mounts the pill + modal DOM and returns a controller. The CM extension
// returned by composeUpdateListener feeds it selection signals; main.ts
// owns wiring the two together so this module stays decoupled from CM
// internals beyond `view.coordsAtPos`.
export function mountComposePill(
  view: EditorView,
  store: CommentStore,
  onThreadCreated: (threadId: string) => void,
): ComposeController {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'comment-pill';
  pill.textContent = '💬 Comment';
  pill.style.display = 'none';
  document.body.appendChild(pill);

  let activeSelection: PendingSelection | null = null;
  let modal: HTMLDivElement | null = null;

  const hidePill = () => {
    pill.style.display = 'none';
    activeSelection = null;
  };

  const showPill = (sel: PendingSelection) => {
    const coords = view.coordsAtPos(sel.to);
    if (!coords) { hidePill(); return; }
    activeSelection = sel;
    pill.style.left = `${coords.left + window.scrollX}px`;
    pill.style.top = `${coords.top + window.scrollY - 36}px`;
    pill.style.display = 'inline-flex';
  };

  const closeModal = () => {
    if (!modal) return;
    modal.remove();
    modal = null;
  };

  const openModal = () => {
    if (!activeSelection || modal) return;
    const sel = activeSelection;
    modal = document.createElement('div');
    modal.className = 'comment-compose-modal';
    const coords = view.coordsAtPos(sel.to);
    if (coords) {
      modal.style.left = `${coords.left + window.scrollX}px`;
      modal.style.top = `${coords.bottom + window.scrollY + 6}px`;
    }
    modal.innerHTML = `
      <textarea class="comment-compose-text" placeholder="Add a comment..." rows="3"></textarea>
      <div class="comment-compose-actions">
        <button type="button" class="btn comment-compose-cancel">Cancel</button>
        <button type="button" class="btn btn-primary comment-compose-submit">Comment</button>
      </div>
    `;
    document.body.appendChild(modal);
    const ta = modal.querySelector<HTMLTextAreaElement>('.comment-compose-text')!;
    ta.focus();
    const cancel = () => closeModal();
    modal.querySelector<HTMLButtonElement>('.comment-compose-cancel')!.addEventListener('click', cancel);
    modal.querySelector<HTMLButtonElement>('.comment-compose-submit')!.addEventListener('click', async () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      try {
        const thread = await store.createThread({ from: sel.from, to: sel.to }, body);
        closeModal();
        hidePill();
        onThreadCreated(thread.id);
      } catch (err) {
        alert(`Couldn't create comment: ${err}`);
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        modal!.querySelector<HTMLButtonElement>('.comment-compose-submit')!.click();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  };

  pill.addEventListener('click', openModal);

  return {
    onSelectionChange(sel) {
      if (sel) showPill(sel);
      else hidePill();
    },
    destroy() {
      hidePill();
      closeModal();
      pill.remove();
    },
  };
}

// CM extension factory. Watches the main selection and fires the supplied
// callback with the range (after a stay-delay) or null when the selection
// collapses. The callback is bound to a ComposeController's onSelectionChange.
export function composeUpdateListener(
  onSelectionStable: (sel: PendingSelection | null) => void,
): Extension {
  let pending: PendingSelection | null = null;
  let stayTimer: number | null = null;
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return;
    const sel = update.state.selection.main;
    if (sel.from === sel.to) {
      pending = null;
      if (stayTimer !== null) { clearTimeout(stayTimer); stayTimer = null; }
      onSelectionStable(null);
      return;
    }
    pending = { from: sel.from, to: sel.to };
    if (stayTimer !== null) clearTimeout(stayTimer);
    // Hide pill while the user is still moving the selection.
    onSelectionStable(null);
    stayTimer = window.setTimeout(() => {
      stayTimer = null;
      onSelectionStable(pending);
    }, STAY_DELAY_MS);
  });
}
