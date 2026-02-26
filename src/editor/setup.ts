import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';

export function createEditor(
  parent: HTMLElement,
  extraExtensions: Extension[] = [],
  readOnly = false
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
    ...extraExtensions,
  ];

  if (readOnly) {
    extensions.push(EditorView.editable.of(false));
  }

  return new EditorView({
    state: EditorState.create({ doc: '', extensions }),
    parent,
  });
}
