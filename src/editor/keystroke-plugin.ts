import { EditorState, Transaction, type Extension } from '@codemirror/state';
import type { EventType } from '../types';

// Snapshot of a single LOCAL CodeMirror transaction, captured at transaction
// FILTER time — before any state field, view plugin, or update listener has
// observed the change. The Y.Doc updateV2 handler in main.ts consumes one
// of these per local update and pairs it with the binary CRDT delta to
// produce a signed RawEvent.
//
// from/to/inserted/deleted/cursorAfter describe the change in the LOCAL
// view of the merged document. They're no longer authoritative for
// reconstructing the document at replay time (the yjsUpdate field handles
// that) — they survive for paste detection, humanness analysis, and as a
// v1-style fallback for any event that somehow ships without a yjsUpdate.
export interface PendingCaptureContext {
  timestamp: number;
  eventType: EventType;
  from: number;
  to: number;
  inserted: string;
  deleted: string;
  cursorAfter: number;
}

let pending: PendingCaptureContext | null = null;

function mapUserEvent(annotation: string | undefined): EventType {
  if (!annotation) return 'unknown';
  if (annotation.startsWith('input.type')) return 'input.type';
  if (annotation.startsWith('input.paste')) return 'input.paste';
  if (annotation.startsWith('input.drop')) return 'input.drop';
  if (annotation.startsWith('input.complete')) return 'input.complete';
  if (annotation.startsWith('delete') && annotation.includes('backward')) return 'delete.backward';
  if (annotation.startsWith('delete') && annotation.includes('forward')) return 'delete.forward';
  if (annotation.startsWith('delete') && annotation.includes('cut')) return 'delete.cut';
  if (annotation.startsWith('delete')) return 'delete.selection';
  if (annotation.startsWith('undo')) return 'undo';
  if (annotation.startsWith('redo')) return 'redo';
  return 'unknown';
}

// Records context for the next-to-be-applied local CodeMirror transaction.
// Implemented as a transactionFilter (not an updateListener) because
// y-codemirror.next is a ViewPlugin — its update() runs BEFORE listeners
// fire and synchronously mutates Y.Text, which triggers Y.Doc.updateV2 in
// the same call frame. By the time a listener runs, updateV2 has already
// looked for a context and found none. transactionFilters run during
// transaction creation in EditorState.update(), strictly before any state
// field or view plugin sees the change — so pending is always set by the
// time y-codemirror forwards the edit and updateV2 fires.
export function captureContextExtension(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    // Remote-origin transactions are co-author edits being applied locally
    // by y-codemirror after a y-partykit sync. Those live on the originating
    // peer's signed chain, not ours.
    if (tr.annotation(Transaction.remote)) return tr;

    const userEvent = tr.annotation(Transaction.userEvent);
    const eventType = mapUserEvent(userEvent);

    // One CM transaction can carry multiple iterChanges ranges (multi-cursor,
    // formatting that wraps + replaces, etc.) — y-codemirror commits them all
    // inside a single Y.Doc transaction, producing ONE updateV2. Aggregate so
    // the resulting signed event covers the full change.
    let aggFrom = -1;
    let aggTo = -1;
    let insertedAll = '';
    let deletedAll = '';
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (aggFrom === -1) aggFrom = fromA;
      aggTo = toA;
      insertedAll += inserted.toString();
      deletedAll += tr.startState.doc.sliceString(fromA, toA);
    });
    if (aggFrom === -1) return tr;

    pending = {
      timestamp: performance.now(),
      eventType,
      from: aggFrom,
      to: aggTo,
      inserted: insertedAll,
      deleted: deletedAll,
      cursorAfter: tr.newSelection.main.head,
    };
    return tr;
  });
}

// Read and clear the pending capture context. The Y.Doc updateV2 handler
// calls this synchronously, right after y-codemirror commits the local
// change into Y.Text. Returns null if no local CM transaction set context
// (e.g. programmatic Y.Doc edits, or recovery-time applyUpdate calls).
export function consumePendingCaptureContext(): PendingCaptureContext | null {
  const ctx = pending;
  pending = null;
  return ctx;
}
