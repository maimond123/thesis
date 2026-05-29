import { EditorView } from '@codemirror/view';

// Tiny helpers that mutate the editor selection with markdown syntax. These
// run inside a single CodeMirror transaction, so the keystroke-capture plugin
// observes them as ordinary edits and signs them into the chain.

// Wrap (or unwrap, if already wrapped) the current selection with the given
// before/after markers. With an empty selection, inserts the markers and
// places the cursor between them.
export function wrapSelection(view: EditorView, before: string, after = before): boolean {
  const sel = view.state.selection.main;
  const selected = view.state.doc.sliceString(sel.from, sel.to);

  if (selected.length > 0 && selected.startsWith(before) && selected.endsWith(after)) {
    const unwrapped = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: unwrapped },
      selection: { anchor: sel.from, head: sel.from + unwrapped.length },
      userEvent: 'input.format',
    });
  } else if (selected.length === 0) {
    view.dispatch({
      changes: { from: sel.from, insert: before + after },
      selection: { anchor: sel.from + before.length },
      userEvent: 'input.format',
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: before + selected + after },
      selection: { anchor: sel.from + before.length, head: sel.from + before.length + selected.length },
      userEvent: 'input.format',
    });
  }
  view.focus();
  return true;
}

// Toggle a line-leading prefix (heading marker, list bullet, blockquote, etc.)
// on every line in the current selection. If every line already has the prefix,
// remove it; otherwise add it.
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const lines: { from: number; text: string }[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    lines.push({ from: line.from, text: line.text });
  }
  const allPrefixed = lines.every((l) => l.text.startsWith(prefix));
  const changes = lines.map((l) =>
    allPrefixed
      ? { from: l.from, to: l.from + prefix.length, insert: '' }
      : { from: l.from, insert: prefix },
  );
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
  return true;
}

// Replace any existing heading marker on the current line with the given level
// (1–6). Passing level 0 strips the heading.
export function setHeading(view: EditorView, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const stripped = line.text.replace(/^#{1,6}\s+/, '');
  const replacement = level === 0 ? stripped : `${'#'.repeat(level)} ${stripped}`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replacement },
    userEvent: 'input.format',
  });
  view.focus();
  return true;
}
