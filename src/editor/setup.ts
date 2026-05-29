import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export function createEditor(
  parent: HTMLElement,
  yText: Y.Text,
  awareness: Awareness,
  extraExtensions: Extension[] = [],
  readOnly = false,
): EditorView {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    syntaxHighlighting(defaultHighlightStyle),
    markdown(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    // y-codemirror.next binding — Y.Text is the source of truth; CodeMirror is a view.
    yCollab(yText, awareness),
    ...extraExtensions,
  ];

  if (readOnly) {
    extensions.push(EditorView.editable.of(false));
  }

  return new EditorView({
    state: EditorState.create({ doc: yText.toString(), extensions }),
    parent,
  });
}
