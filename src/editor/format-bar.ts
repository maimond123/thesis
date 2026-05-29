import type { EditorView } from '@codemirror/view';
import { wrapSelection, toggleLinePrefix, setHeading } from './formatting';

// A small horizontal formatting toolbar that sits above the editor. Each button
// dispatches a single CodeMirror transaction with `userEvent: 'input.format'`
// — the keystroke plugin observes that transaction and signs the resulting
// characters into the chain just like ordinary typing.

interface ToolbarButton {
  label: string;
  title: string;
  className?: string;
  run: (view: EditorView) => void;
}

const SEPARATOR = '__sep__';

const buttons: (ToolbarButton | typeof SEPARATOR)[] = [
  { label: 'H1', title: 'Heading 1', run: (v) => setHeading(v, 1) },
  { label: 'H2', title: 'Heading 2', run: (v) => setHeading(v, 2) },
  { label: 'H3', title: 'Heading 3', run: (v) => setHeading(v, 3) },
  SEPARATOR,
  { label: 'B', title: 'Bold  (⌘B)', className: 'format-btn-bold', run: (v) => wrapSelection(v, '**') },
  { label: 'I', title: 'Italic  (⌘I)', className: 'format-btn-italic', run: (v) => wrapSelection(v, '*') },
  { label: 'S', title: 'Strikethrough  (⌘⇧X)', className: 'format-btn-strike', run: (v) => wrapSelection(v, '~~') },
  { label: '<>', title: 'Inline code  (⌘E)', className: 'format-btn-code', run: (v) => wrapSelection(v, '`') },
  SEPARATOR,
  { label: '•', title: 'Bulleted list  (⌘⇧8)', run: (v) => toggleLinePrefix(v, '- ') },
  { label: '1.', title: 'Numbered list  (⌘⇧7)', run: (v) => toggleLinePrefix(v, '1. ') },
  { label: '"', title: 'Block quote  (⌘⇧9)', run: (v) => toggleLinePrefix(v, '> ') },
  SEPARATOR,
  { label: '🔗', title: 'Link', run: (v) => wrapSelection(v, '[', '](https://)') },
  { label: '—', title: 'Horizontal rule', run: (v) => insertHorizontalRule(v) },
];

function insertHorizontalRule(view: EditorView): void {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const prefix = line.text.length > 0 ? '\n\n' : '';
  view.dispatch({
    changes: { from: line.to, insert: `${prefix}---\n` },
    userEvent: 'input.format',
  });
  view.focus();
}

export function mountFormatBar(container: HTMLElement, getView: () => EditorView | null): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'format-bar';

  for (const item of buttons) {
    if (item === SEPARATOR) {
      const sep = document.createElement('span');
      sep.className = 'format-btn-divider';
      bar.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `format-btn ${item.className ?? ''}`.trim();
    btn.title = item.title;
    btn.textContent = item.label;
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in editor
    btn.addEventListener('click', () => {
      const view = getView();
      if (view) item.run(view);
    });
    bar.appendChild(btn);
  }

  container.appendChild(bar);
  return bar;
}
