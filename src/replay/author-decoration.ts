import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

// Per-author character coloring for the Replay tab. A CodeMirror StateField
// holds a DecorationSet of "mark" decorations, each tagged with a class
// `cm-author-N`. CSS in styles.css maps N → color.
//
// Mark decorations are automatically remapped by CodeMirror through any
// subsequent change, so as the replay engine inserts/deletes around them,
// each character keeps the colour of whoever originally typed it.

export interface AuthorMark {
  from: number;
  to: number;
  authorIndex: number;
}

export const addAuthorMark = StateEffect.define<AuthorMark>();
export const clearAuthorMarks = StateEffect.define<void>();

export const authorMarkField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addAuthorMark)) {
        const { from, to, authorIndex } = e.value;
        if (to > from) {
          next = next.update({
            add: [Decoration.mark({ class: `cm-author cm-author-${authorIndex}` }).range(from, to)],
          });
        }
      } else if (e.is(clearAuthorMarks)) {
        next = Decoration.none;
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function authorDecorationExtension(): Extension {
  return [authorMarkField];
}
