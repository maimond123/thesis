import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { wrapSelection, toggleLinePrefix } from './formatting';

// "Page that grows with content" theme — overrides CodeMirror's defaults that
// otherwise cap the editor at the scroller's flex-grown box. With these rules
// the .cm-editor element itself extends as text is added, so the cream page
// background reaches the last line instead of stopping mid-document. Hard
// word-wrap handles long unbroken sequences like hashes / URLs.
const pageTheme = EditorView.theme({
  '&': {
    height: 'auto',
    minHeight: '1056px',
  },
  '.cm-scroller': {
    overflow: 'visible',
    flex: 'none',
    height: 'auto',
    minHeight: '100%',
  },
  '.cm-content, .cm-line': {
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
});

// Rich markdown-aware highlighting — headings render visibly larger and bold,
// **bold** is bold, *italic* is italic, > quotes are dimmed, code spans get
// a mono background, etc. The raw markdown markers stay visible (this is still
// a markdown editor, not WYSIWYG) but the formatted text reads at-a-glance.
const richMarkdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.9em', fontWeight: '700', lineHeight: '1.25' },
  { tag: tags.heading2, fontSize: '1.55em', fontWeight: '700', lineHeight: '1.3' },
  { tag: tags.heading3, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading4, fontSize: '1.15em', fontWeight: '700' },
  { tag: tags.heading5, fontSize: '1.05em', fontWeight: '700' },
  { tag: tags.heading6, fontSize: '1em', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', class: 'cm-md-code' },
  { tag: tags.quote, fontStyle: 'italic', color: 'var(--text-muted)' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)' }, // markers like ** > #
  { tag: tags.meta, color: 'var(--text-muted)' },
]);

// Cmd/Ctrl-keyed shortcuts that mirror the formatting toolbar.
function formatKeymap() {
  return keymap.of([
    { key: 'Mod-b', run: (v) => wrapSelection(v, '**') },
    { key: 'Mod-i', run: (v) => wrapSelection(v, '*') },
    { key: 'Mod-Shift-x', run: (v) => wrapSelection(v, '~~') },
    { key: 'Mod-e', run: (v) => wrapSelection(v, '`') },
    { key: 'Mod-Shift-7', run: (v) => toggleLinePrefix(v, '1. ') },
    { key: 'Mod-Shift-8', run: (v) => toggleLinePrefix(v, '- ') },
    { key: 'Mod-Shift-9', run: (v) => toggleLinePrefix(v, '> ') },
  ]);
}

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
    syntaxHighlighting(richMarkdownStyle),
    markdown(),
    history(),
    formatKeymap(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    pageTheme,
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
