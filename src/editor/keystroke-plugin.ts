import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import type { EventType, RawEvent } from '../types';

export type OnEventCallback = (event: RawEvent) => void;

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

export function keystrokeCaptureExtension(onEvent: OnEventCallback) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;

    for (const tr of update.transactions) {
      const userEvent = tr.annotation(Transaction.userEvent);
      const eventType = mapUserEvent(userEvent);

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const deleted = update.startState.doc.sliceString(fromA, toA);
        const cursorAfter = update.state.selection.main.head;

        onEvent({
          timestamp: performance.now(),
          type: eventType,
          from: fromA,
          to: toA,
          inserted: inserted.toString(),
          deleted,
          cursorAfter,
        });
      });
    }
  });
}
