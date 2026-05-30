import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createEditor } from './editor/setup';
import { captureContextExtension, consumePendingCaptureContext } from './editor/keystroke-plugin';
import { bytesToBase64 } from './editor/yjs-bytes';
import { CommentStore } from './comments/comment-store';
import {
  commentDecorationExtension,
  buildAnchorPreviews,
  setThreadAnchors,
  setActiveThread,
} from './comments/decorations';
import { mountComposePill, composeUpdateListener } from './comments/compose-ui';
import { mountCommentsSidePanel, type CommentsSidePanel } from './comments/side-panel';
import { mountFormatBar } from './editor/format-bar';
import { SessionManager } from './session/session-manager';
import { downloadProof } from './export/exporter';
import { importFromFile } from './export/importer';
import { ReplayView } from './replay/replay-view';
import { VerifyUI } from './verification/verify-ui';
import { anchorHashOnChain, explorerUrl, chainName } from './crypto/ethereum';
import { IdentityStore } from './identity/identity-store';
import { IdentityUI } from './identity/identity-ui';
import { PartyKitSync, type ChainMessage } from './sync/partykit-sync';
import { FileIndex } from './files/file-index';
import { FileSidebar } from './files/sidebar';
import type { ProofFile } from './types';

// File routing: the document being edited is identified by the URL hash. So
// localhost:5173/#chapter-1 shares a room with everyone on the same URL, while
// #chapter-2 is a completely separate document with its own per-author chains,
// PartyKit room, Yjs doc, and IndexedDB session. Falls back to 'default' when
// the hash is empty. Switching files requires a reload (intentional — keeps
// the state model simple; each tab handles exactly one file at a time).

function readFileIdFromHash(): string {
  const raw = window.location.hash.slice(1).trim();
  if (!raw) return 'default';
  // Restrict to URL-safe characters so file IDs round-trip cleanly through
  // PartyKit room paths and IndexedDB keys.
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'default';
}

const SLICE1_FILE_ID = readFileIdFromHash();

// Reload the page when the hash changes so we re-enter with a fresh
// SessionManager + PartyKit connection for the new fileId.
window.addEventListener('hashchange', () => {
  if (readFileIdFromHash() !== SLICE1_FILE_ID) window.location.reload();
});

// ─── Theme (dark / light) ─────────────────────────────────────────
// Initial theme: stored preference > OS preference > dark. The toggle in the
// header flips this and persists. CSS variables under `[data-theme="light"]`
// override the defaults.

type Theme = 'dark' | 'light';
const THEME_KEY = 'thesis-theme';

function readInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY) as Theme | null;
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

applyTheme(readInitialTheme());

// ─── Identity bootstrap (top-level await) ─────────────────────────
// Identity must exist before any session can record. First run prompts for a handle.

const identityStore = new IdentityStore();
const identityUI = new IdentityUI(identityStore);
let self = await identityStore.loadSelf();
if (!self) {
  self = await identityUI.showFirstRunModal();
}

// ─── File index ────────────────────────────────────────────────────
// Tracks every fileId this browser has opened so the sidebar can list past
// documents. Slice-2 will add a signed project manifest; for now this is a
// local convenience cache only.
const fileIndex = new FileIndex();
await fileIndex.recordVisit(SLICE1_FILE_ID);

// ─── Shared doc state (Yjs) ────────────────────────────────────────
// Y.Doc is the source of truth for the document. The CodeMirror editor is
// a view bound to a Y.Text within this doc via y-codemirror.next. Co-author
// edits arrive through PartyKit (Task 5) and update the same Y.Text.

const ydoc = new Y.Doc();
const yText = ydoc.getText('main');
const awareness = new Awareness(ydoc);

function publishLocalAwareness(): void {
  const s = identityStore.getSelf();
  awareness.setLocalStateField('user', {
    handle: s.handle,
    thumbprint: s.thumbprint,
    short: `${s.thumbprint.slice(0, 6)}…${s.thumbprint.slice(-4)}`,
  });
}
publishLocalAwareness();
// Re-publish whenever the identity changes (rename, backup-marked, etc.) so
// co-authors see the new handle live in their presence cursors.
identityStore.onChange(publishLocalAwareness);

// ─── State ─────────────────────────────────────────────────────────

const session = new SessionManager(identityStore, SLICE1_FILE_ID);
let editorView: ReturnType<typeof createEditor> | null = null;
let lastProof: ProofFile | null = null;
let replayView: ReplayView;

// Comments — review activity layered on top of the keystroke chain. Lives in
// the same Y.Doc so y-partykit syncs threads + replies to peers for free.
// Built after the editor view exists so the compose pill has a CM view to
// position itself against, but the store itself depends only on the Y.Doc.
const commentStore = new CommentStore(ydoc, yText, identityStore);
// Stable per-author colour for comment underlines. Reuses the same palette
// the Replay author marks use; index by first appearance among comment
// authors (so the first author to comment is cm-author-0 etc.).
const commentAuthorIndex = new Map<string, number>();
function colorIndexForCommentAuthor(thumb: string): number {
  if (!commentAuthorIndex.has(thumb)) {
    commentAuthorIndex.set(thumb, commentAuthorIndex.size % 6);
  }
  return commentAuthorIndex.get(thumb)!;
}
let sidePanel: CommentsSidePanel | null = null;

// ─── PartyKit live sync ────────────────────────────────────────────
let partyStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

const partyKitSync = new PartyKitSync({
  fileId: SLICE1_FILE_ID,
  ydoc,
  awareness,
  onChainMessage: (msg: ChainMessage) => {
    if (!msg?.payload) return;
    const payload = msg.payload as { event?: import('./types').AuthoringEvent; coAuthor?: { thumbprint: string; handle: string; publicKey: JsonWebKey } };
    if (!payload.event) return;
    void session.appendRemoteEvent(msg.fromThumbprint, payload.event, payload.coAuthor);
  },
  onStatus: (s) => {
    partyStatus = s;
  },
});
partyKitSync.connect();

session.onLocalEventAppended = (authorThumbprint, event) => {
  if (partyStatus !== 'connected') return;
  partyKitSync.sendChainMessage({
    kind: 'chain',
    fromThumbprint: authorThumbprint,
    payload: {
      event,
      coAuthor: {
        thumbprint: self.thumbprint,
        handle: self.handle,
        publicKey: self.publicKey,
      },
    },
  });
};

// ─── Build DOM ─────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>('#app')!;

// Header
const header = document.createElement('div');
header.className = 'header';
header.innerHTML = `<span class="header-title">thesis</span><span class="header-file" title="Edit URL hash to switch files">#${SLICE1_FILE_ID}</span>`;
const headerRight = document.createElement('div');
headerRight.className = 'header-right';
header.appendChild(headerRight);
app.appendChild(header);

// Theme toggle button (left of the identity badge).
const themeToggle = document.createElement('button');
themeToggle.className = 'theme-toggle';
themeToggle.type = 'button';
themeToggle.title = 'Toggle light / dark theme';
function syncThemeToggleIcon(): void {
  const isLight = document.documentElement.dataset.theme === 'light';
  themeToggle.textContent = isLight ? '☾' : '☼';   // moon (dark mode option) / sun (light mode option)
  themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
}
syncThemeToggleIcon();
themeToggle.addEventListener('click', () => {
  const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  syncThemeToggleIcon();
});
headerRight.appendChild(themeToggle);

identityUI.mountBadge(headerRight);

// ─── Identity backup nag banner ────────────────────────────────────
// If the user hasn't backed up their identity (private key), nag them
// until they do. Losing the browser's IndexedDB without a backup means
// the chain becomes unrecoverable — there is no recovery path.

const backupBanner = document.createElement('div');
backupBanner.className = 'backup-nag';
backupBanner.innerHTML = `
  <span class="backup-nag-icon">!</span>
  <span class="backup-nag-text">
    <strong>Back up your identity.</strong>
    If you lose this browser's data without a backup, your chain becomes unrecoverable.
  </span>
  <button class="btn btn-primary backup-nag-btn">Back up now</button>
`;
backupBanner.querySelector<HTMLButtonElement>('.backup-nag-btn')!.addEventListener('click', () => {
  identityUI.openBackupFlow();
});

function refreshBackupBanner(): void {
  backupBanner.style.display = identityStore.isBackedUp() ? 'none' : 'flex';
}

identityStore.onBackupStateChange(refreshBackupBanner);
app.appendChild(backupBanner);
refreshBackupBanner();

// Tabs
const tabsEl = document.createElement('div');
tabsEl.className = 'tabs';
const tabNames = ['Editor', 'Replay', 'Verify'] as const;
type TabName = typeof tabNames[number];
let activeTab: TabName = 'Editor';

for (const name of tabNames) {
  const btn = document.createElement('button');
  btn.className = `tab${name === activeTab ? ' active' : ''}`;
  btn.textContent = name;
  btn.dataset.tab = name;
  btn.addEventListener('click', () => switchTab(name));
  tabsEl.appendChild(btn);
}
app.appendChild(tabsEl);

// Toolbar
const toolbar = document.createElement('div');
toolbar.className = 'toolbar';

const startBtn = document.createElement('button');
startBtn.className = 'btn btn-primary';
startBtn.textContent = 'Start Session';

const endBtn = document.createElement('button');
endBtn.className = 'btn btn-danger';
endBtn.textContent = 'End Session';
endBtn.disabled = true;

const exportBtn = document.createElement('button');
exportBtn.className = 'btn';
exportBtn.textContent = 'Export Proof';
exportBtn.disabled = true;

const importBtn = document.createElement('button');
importBtn.className = 'btn';
importBtn.textContent = 'Import Proof';

const commentsBtn = document.createElement('button');
commentsBtn.className = 'btn';
commentsBtn.textContent = 'Comments';
commentsBtn.title = 'Show review threads on this document';

const loadSessionBtn = document.createElement('button');
loadSessionBtn.className = 'btn';
loadSessionBtn.textContent = 'Load Session';

const spacer = document.createElement('div');
spacer.className = 'toolbar-spacer';

const commitHashEl = document.createElement('div');
commitHashEl.className = 'commit-hash-display';
commitHashEl.style.display = 'none';

toolbar.appendChild(startBtn);
toolbar.appendChild(endBtn);
toolbar.appendChild(loadSessionBtn);
toolbar.appendChild(spacer);
toolbar.appendChild(exportBtn);
toolbar.appendChild(importBtn);
toolbar.appendChild(commentsBtn);
app.appendChild(toolbar);

commentsBtn.addEventListener('click', () => sidePanel?.toggle());

// Test-only hooks: scripts/test-comments-e2e.mjs reaches into the page to
// create threads and verify signatures without simulating the pill click.
// Cheap to expose and the references are read-only beyond the methods we
// already document publicly.
(window as unknown as Record<string, unknown>).__commentStoreForTests = commentStore;
(window as unknown as Record<string, unknown>).__identityStoreForTests = identityStore;
(window as unknown as Record<string, unknown>).__sessionForTests = session;

// Main area: sidebar + view container side by side.
const mainArea = document.createElement('div');
mainArea.className = 'main-area';

// Sidebar (file list + new-file button) sits to the left of the views.
new FileSidebar(mainArea, fileIndex, SLICE1_FILE_ID);

// View container
const viewContainer = document.createElement('div');
viewContainer.className = 'view-container';

// Editor panel
const editorPanel = document.createElement('div');
editorPanel.className = 'view-panel active';
editorPanel.id = 'editor-panel';

// Format bar (Bold / Italic / Headings / Lists) lives between the toolbar
// and the page so formatting actions are one click away.
mountFormatBar(editorPanel, () => editorView);

const editorContainer = document.createElement('div');
editorContainer.className = 'editor-container';
editorPanel.appendChild(editorContainer);
viewContainer.appendChild(editorPanel);

// Replay panel
replayView = new ReplayView(viewContainer);

// Verify panel
const verifyPanel = document.createElement('div');
verifyPanel.className = 'view-panel';
verifyPanel.id = 'verify-panel';
viewContainer.appendChild(verifyPanel);

new VerifyUI(verifyPanel, (proof) => {
  lastProof = proof;
  replayView.loadProof(proof);
});

mainArea.appendChild(viewContainer);
app.appendChild(mainArea);

// Commit hash display (below toolbar when visible, above the main sidebar+view area)
app.insertBefore(commitHashEl, mainArea);

// Status bar
const statusBar = document.createElement('div');
statusBar.className = 'status-bar';

const statusGroup = document.createElement('span');
statusGroup.className = 'status-item';
const statusDot = document.createElement('span');
statusDot.className = 'status-dot idle';
const statusText = document.createElement('span');
statusText.textContent = 'Idle';
statusGroup.appendChild(statusDot);
statusGroup.appendChild(statusText);

const eventCount = document.createElement('span');
eventCount.className = 'status-item';
eventCount.textContent = 'Events: 0';

const checkpointCount = document.createElement('span');
checkpointCount.className = 'status-item';
checkpointCount.textContent = 'Checkpoints: 0';

// Tier freshness indicators — one per durability layer.
const tierLocal = createTierIndicator('IDB');
const tierEmergency = createTierIndicator('Local');
const tierCloud = createTierIndicator('Cloud');
const tierLive = createTierIndicator('Live');

statusBar.appendChild(statusGroup);
statusBar.appendChild(eventCount);
statusBar.appendChild(checkpointCount);
statusBar.appendChild(tierLocal.el);
statusBar.appendChild(tierEmergency.el);
statusBar.appendChild(tierCloud.el);
statusBar.appendChild(tierLive.el);
app.appendChild(statusBar);

function createTierIndicator(label: string): { el: HTMLSpanElement; setState: (state: 'ok' | 'stale' | 'down' | 'idle', ageMs: number | null) => void } {
  const wrap = document.createElement('span');
  wrap.className = 'status-item tier';
  const dot = document.createElement('span');
  dot.className = 'tier-dot idle';
  const text = document.createElement('span');
  text.textContent = `${label}: —`;
  wrap.appendChild(dot);
  wrap.appendChild(text);
  return {
    el: wrap,
    setState(state, ageMs) {
      dot.className = `tier-dot ${state}`;
      if (state === 'idle' || ageMs === null) {
        text.textContent = `${label}: —`;
      } else if (state === 'down') {
        text.textContent = `${label}: error`;
      } else {
        const sec = Math.round(ageMs / 1000);
        text.textContent = `${label}: ${sec}s`;
      }
    },
  };
}

let lastCloudOk = true;

function refreshTiers(): void {
  const now = Date.now();

  // For a tier with pending data, age = time since last save. If everything
  // is already saved, the tier is OK regardless of how long ago the save was.
  const tierForPending = (last: number | null, fullySaved: boolean, okMs: number, staleMs: number) => {
    if (session.state !== 'recording') return { state: 'idle' as const, age: null };
    if (fullySaved) return { state: 'ok' as const, age: last ? now - last : 0 };
    if (last === null) return { state: 'down' as const, age: null };
    const age = now - last;
    if (age <= okMs) return { state: 'ok' as const, age };
    if (age <= staleMs) return { state: 'stale' as const, age };
    return { state: 'down' as const, age };
  };

  const idb = tierForPending(session.lastIdbSaveAt, session.isFullyPersistedToIdb(), 2_000, 10_000);
  tierLocal.setState(idb.state, idb.age);

  // localStorage emergency tier is purely time-based — it fires on a 30s
  // schedule regardless of whether there are new events.
  if (session.state !== 'recording') {
    tierEmergency.setState('idle', null);
  } else if (session.lastEmergencySaveAt === null) {
    tierEmergency.setState('stale', null);
  } else {
    const age = now - session.lastEmergencySaveAt;
    if (age <= 45_000) tierEmergency.setState('ok', age);
    else if (age <= 120_000) tierEmergency.setState('stale', age);
    else tierEmergency.setState('down', age);
  }

  if (session.state === 'recording') {
    if (!lastCloudOk) {
      tierCloud.setState('down', null);
    } else {
      const cl = tierForPending(session.lastCloudSaveAt, session.isFullyPersistedToCloud(), 15_000, 60_000);
      tierCloud.setState(cl.state, cl.age);
    }
  } else {
    tierCloud.setState('idle', null);
  }

  // Live (PartyKit) tier — purely status-driven, not freshness.
  if (partyStatus === 'connected') tierLive.setState('ok', 0);
  else if (partyStatus === 'connecting') tierLive.setState('stale', null);
  else tierLive.setState('down', null);
}

window.setInterval(refreshTiers, 1_000);

// ─── Create editor ─────────────────────────────────────────────────

// Capture gating — disabled during recovery to avoid duplicate events
let setCaptureEnabled: (v: boolean) => void = () => {};
let isCaptureEnabled: () => boolean = () => true;

// Pair each local CodeMirror keystroke with the Yjs binary update it produced
// so replay can apply the CRDT delta to a fresh Y.Doc and reconstruct the
// merged document exactly as Yjs computed it live — instead of replaying
// position-based diffs that scramble across concurrent multi-author edits.
//
// Within a single CodeMirror dispatch the order is:
//   1. CodeMirror commits the local transaction; view.state is updated.
//   2. Update listeners fire in Prec order:
//        a. captureContextExtension (Prec.highest) stashes userEvent + agg
//           from/to/inserted/deleted/cursorAfter for THIS transaction.
//        b. y-codemirror.next forwards the change into Y.Text. Y.Doc commits
//           the transaction → fires updateV2 SYNCHRONOUSLY before y-codemirror
//           returns. The handler below reads the stashed context and ships a
//           single signed RawEvent carrying the binary update.
// Result: one CM transaction = one Y.Doc updateV2 = one signed event, even
// when iterChanges produced multiple ranges. The first-iterChanges-only bug
// from the previous wiring is gone.

ydoc.on('updateV2', (update: Uint8Array, origin: unknown) => {
  // Skip remote updates — those came from peers via the y-partykit provider
  // and live on the originating peer's signed chain.
  if (origin && origin === partyKitSync.getProvider()) return;

  // Gated during recovery / auto-start so applying historical updates to the
  // live Y.Doc doesn't re-sign events that already exist on disk.
  if (!isCaptureEnabled()) return;

  const ctx = consumePendingCaptureContext();
  if (!ctx) {
    // Local updateV2 with no matching CM transaction — programmatic Y.Text
    // edit (e.g. v1 recovery's setDocument). Nothing to sign here.
    return;
  }

  if (session.state !== 'recording') {
    // The doc still propagates to peers because Y.Text was mutated; we just
    // don't sign the event onto our chain. Nudge the writer so they realise
    // before they've lost a lot of unsigned typing.
    showStartSessionToast();
    return;
  }

  session.handleEvent({
    timestamp: ctx.timestamp,
    wallClock: ctx.wallClock,
    type: ctx.eventType,
    from: ctx.from,
    to: ctx.to,
    inserted: ctx.inserted,
    deleted: ctx.deleted,
    cursorAfter: ctx.cursorAfter,
    yjsUpdate: bytesToBase64(update),
  });
});

// Build the comment extensions BEFORE createEditor so they go in as proper
// CM extensions (StateField + decorations + click handler + selection
// listener for the pill). The selection listener is wired to feed the
// compose-pill controller created right after the editor view exists.
let composeOnSelection: ((sel: { from: number; to: number } | null) => void) | null = null;
const composeListenerExt = composeUpdateListener((sel) => composeOnSelection?.(sel));
const commentDecoExt = commentDecorationExtension(
  commentStore,
  colorIndexForCommentAuthor,
  (threadId) => { sidePanel?.open(threadId); },
);

editorView = createEditor(editorContainer, yText, awareness, [
  captureContextExtension(),
  commentDecoExt,
  composeListenerExt,
]);

// Compose pill + side panel are DOM-level. The pill lives in document.body
// so it can float over the editor; the side panel docks to the main viewport
// container so it sits to the right of the editor area.
const composeController = mountComposePill(editorView, commentStore, (threadId) => {
  sidePanel?.open(threadId);
});
composeOnSelection = composeController.onSelectionChange;

sidePanel = mountCommentsSidePanel(
  mainArea,
  commentStore,
  identityStore,
  (range) => {
    const view = editorView!;
    const docLen = view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, docLen));
    const to = Math.max(from, Math.min(range.to, docLen));
    return view.state.doc.sliceString(from, to).slice(0, 80);
  },
  (threadId) => {
    if (editorView) editorView.dispatch({ effects: setActiveThread.of(threadId) });
  },
  (range) => {
    if (!editorView) return;
    editorView.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: [setActiveThread.of(null)],
      scrollIntoView: true,
    });
    editorView.focus();
  },
);

// Push the current thread/anchor preview list into the editor's decoration
// state whenever the store changes (creation, reply, resolve, anchor drift
// from concurrent edits). buildAnchorPreviews re-resolves anchors against
// the live Y.Text on every call, so the underline tracks the doc state.
function refreshCommentDecorations(): void {
  if (!editorView) return;
  const previews = buildAnchorPreviews(commentStore, colorIndexForCommentAuthor);
  editorView.dispatch({ effects: setThreadAnchors.of(previews) });
}
commentStore.onChange(refreshCommentDecorations);
refreshCommentDecorations();

// Also refresh decorations when the doc itself changes (anchors may have
// moved relative to text positions). updateListener at default Prec so it
// runs after y-codemirror has reflected the change into Y.Text.
editorView.dispatch({ effects: [] });   // touch the view so the extension is fully initialised
window.requestAnimationFrame(() => refreshCommentDecorations());

// ─── Session callbacks ─────────────────────────────────────────────

session.onEventAdded = (count) => {
  eventCount.textContent = `Events: ${count}`;
};

session.onCloudSync = (status, message) => {
  if (status === 'saving') {
    // tier indicator handles display; nothing to do here
  } else if (status === 'saved') {
    lastCloudOk = true;
  } else if (status === 'error') {
    lastCloudOk = false;
    console.error('[thesis] Cloud save error:', message);
  }
};

session.onCheckpoint = (_checkpoint, commitment) => {
  checkpointCount.textContent = `Checkpoints: ${session.getCheckpoints().length}`;
  commitHashEl.style.display = 'block';
  commitHashEl.innerHTML = `
    <div class="commit-hash-label">Latest timestamp commitment (click hash to copy):</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div class="commit-hash-value" style="flex:1">${commitment.commitHash}</div>
      <button class="btn btn-primary anchor-btn" style="white-space:nowrap;">Anchor on-chain</button>
    </div>
    <div class="anchor-status" style="font-size:11px;margin-top:4px;color:var(--text-muted);"></div>
  `;
  commitHashEl.querySelector('.commit-hash-value')?.addEventListener('click', () => {
    navigator.clipboard.writeText(commitment.commitHash);
    const val = commitHashEl.querySelector('.commit-hash-value')!;
    const original = val.textContent;
    val.textContent = 'Copied!';
    setTimeout(() => { val.textContent = original; }, 1500);
  });
  commitHashEl.querySelector('.anchor-btn')?.addEventListener('click', async () => {
    const btn = commitHashEl.querySelector('.anchor-btn') as HTMLButtonElement;
    const status = commitHashEl.querySelector('.anchor-status')!;
    btn.disabled = true;
    btn.textContent = 'Waiting for wallet...';
    status.textContent = '';
    try {
      const result = await anchorHashOnChain(commitment.commitHash);
      const url = explorerUrl(result.txHash, result.chainId);
      const network = chainName(result.chainId);
      btn.textContent = 'Anchored!';
      btn.disabled = true;
      status.innerHTML = `Tx on ${network}: ${url ? `<a href="${url}" target="_blank" style="color:var(--accent)">${result.txHash.slice(0, 16)}...</a>` : result.txHash.slice(0, 24) + '...'}`;

      // Save as timestamp anchor in session
      session.addAnchor({
        checkpointSeq: commitment.checkpointSeq,
        commitHash: commitment.commitHash,
        method: 'ethereum',
        proof: JSON.stringify({ txHash: result.txHash, chainId: result.chainId, from: result.from }),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      btn.textContent = 'Anchor on-chain';
      btn.disabled = false;
      status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
      (status as HTMLElement).style.color = 'var(--error)';
    }
  });
};

session.onStateChange = (state) => {
  statusDot.className = `status-dot ${state === 'recording' ? 'recording' : state === 'ended' ? 'ended' : 'idle'}`;
  statusText.textContent = state === 'recording' ? 'Recording' : state === 'ended' ? 'Session ended' : 'Idle';

  startBtn.disabled = state === 'recording';
  endBtn.disabled = state !== 'recording';
  exportBtn.disabled = state !== 'ended' && lastProof === null;

  if (state === 'recording') dismissStartToast();
};

// ─── "Start a session before you write" toast ─────────────────────
// Triggered by the keystroke capture extension when the doc changes while
// no session is recording (e.g. right after a manual End Session). The toast
// auto-dismisses after a few seconds, and instantly when a session starts.

let startToastEl: HTMLDivElement | null = null;
let startToastTimer: number | null = null;

function showStartSessionToast(): void {
  if (startToastEl || session.state === 'recording') return;
  const el = document.createElement('div');
  el.className = 'toast toast-warning';
  el.innerHTML = `
    <span class="toast-text">No session is recording — your keystrokes aren't being signed.</span>
    <button class="btn btn-primary toast-action" type="button">Start session</button>
  `;
  el.querySelector<HTMLButtonElement>('.toast-action')!.addEventListener('click', () => {
    startBtn.click();
    dismissStartToast();
  });
  document.body.appendChild(el);
  startToastEl = el;
  startToastTimer = window.setTimeout(dismissStartToast, 8000);
}

function dismissStartToast(): void {
  startToastEl?.remove();
  startToastEl = null;
  if (startToastTimer !== null) {
    clearTimeout(startToastTimer);
    startToastTimer = null;
  }
}

// ─── Button handlers ───────────────────────────────────────────────

// Auto-export timer — every 5 min during an active session, download a snapshot
// ProofFile so the user has an off-system backup independent of IDB / Vercel / PartyKit.
const AUTO_EXPORT_INTERVAL_MS = 5 * 60 * 1000;
let autoExportTimer: number | null = null;

function startAutoExportTimer(): void {
  stopAutoExportTimer();
  autoExportTimer = window.setInterval(async () => {
    if (session.state !== 'recording') return;
    try {
      const snap = await session.snapshot();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      downloadProof(snap, `thesis-${snap.session.sessionId.slice(0, 8)}-${ts}.json`);
    } catch (err) {
      console.warn('[thesis] Auto-export failed:', err);
    }
  }, AUTO_EXPORT_INTERVAL_MS);
}

function stopAutoExportTimer(): void {
  if (autoExportTimer !== null) {
    clearInterval(autoExportTimer);
    autoExportTimer = null;
  }
}

startBtn.addEventListener('click', async () => {
  if (!editorView) return;

  // Begin recording on the current document state — do NOT wipe. The Y.Text
  // may already contain content synced from peers in the room; the local
  // author's chain just starts capturing new keystrokes from this point on.
  await session.start(() => yText.toString());

  eventCount.textContent = 'Events: 0';
  checkpointCount.textContent = 'Checkpoints: 0';
  commitHashEl.style.display = 'none';
  lastProof = null;
  exportBtn.disabled = true;
  lastCloudOk = true;
  startAutoExportTimer();
});

endBtn.addEventListener('click', async () => {
  stopAutoExportTimer();
  lastProof = await session.end();
  exportBtn.disabled = false;
});

// Force-save on tab close / navigate away
window.addEventListener('beforeunload', () => {
  if (session.state === 'recording') {
    session.forceSaveSync();
  }
});

exportBtn.addEventListener('click', () => {
  if (lastProof) downloadProof(lastProof);
});

importBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      lastProof = await importFromFile(file);
      replayView.loadProof(lastProof);
      switchTab('Replay');
      exportBtn.disabled = false;
    } catch (err) {
      alert(`Import failed: ${err}`);
    }
  });
  input.click();
});

loadSessionBtn.addEventListener('click', async () => {
  if (session.state === 'recording') {
    if (!confirm('End current session and load a cloud session?')) return;
  }
  try {
    const sessions = await session.listCloudSessions();
    if (sessions.length === 0) {
      alert('No saved sessions found in the cloud.');
      return;
    }

    // Show a simple picker dialog
    const picker = document.createElement('div');
    picker.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:999;';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:24px;max-width:500px;width:90%;max-height:70vh;overflow:auto;';
    panel.innerHTML = '<h3 style="margin-bottom:12px;color:var(--accent);">Load Cloud Session</h3>';

    for (const s of sessions) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:pointer;transition:background 0.15s;';
      row.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;color:var(--text);">${s.id}</div><div style="font-size:11px;color:var(--text-muted);">Updated: ${new Date(s.updatedAt).toLocaleString()} | Size: ${(s.size / 1024).toFixed(0)} KB</div>`;
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-elevated)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', async () => {
        picker.remove();
        setCaptureEnabled(false);
        try {
          const ok = await session.recoverFromCloud(
            s.id,
            () => yText.toString(),
            (doc) => {
              ydoc.transact(() => {
                if (yText.length > 0) yText.delete(0, yText.length);
                yText.insert(0, doc);
              });
            },
            (bytes) => { Y.applyUpdateV2(ydoc, bytes); },
          );
          if (ok) {
            eventCount.textContent = `Events: ${session.getEventCount()}`;
            checkpointCount.textContent = `Checkpoints: ${session.getCheckpoints().length}`;
          } else {
            alert('Failed to load session');
          }
        } catch (err) {
          alert(`Load failed: ${err}`);
        }
        setCaptureEnabled(true);
      });
      panel.appendChild(row);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.marginTop = '8px';
    cancelBtn.addEventListener('click', () => picker.remove());
    panel.appendChild(cancelBtn);

    picker.appendChild(panel);
    picker.addEventListener('click', (e) => { if (e.target === picker) picker.remove(); });
    document.body.appendChild(picker);
  } catch (err) {
    alert(`Failed to list sessions: ${err}`);
  }
});

// ─── Auto-recover on load ──────────────────────────────────────────

(async () => {
  try {
    // Pause capture during recovery so restoring the doc doesn't create duplicate events
    let capturing = false;
    setCaptureEnabled = (v: boolean) => { capturing = v; };
    isCaptureEnabled = () => capturing;

    const recovered = await session.recover(
      () => yText.toString(),
      (doc) => {
        // v1 fallback: write the restored text directly into Y.Text inside a
        // transaction so y-codemirror updates the view as one atomic change.
        // Throws away the CRDT history; safe only because v1 sessions are
        // single-author.
        ydoc.transact(() => {
          if (yText.length > 0) yText.delete(0, yText.length);
          yText.insert(0, doc);
        });
      },
      // v2 path: feed each recorded Yjs update back into the live Y.Doc so
      // the CRDT history is rebuilt and reconnecting peers find a doc whose
      // internal state lines up with theirs.
      (bytes) => { Y.applyUpdateV2(ydoc, bytes); },
    );
    if (recovered) {
      eventCount.textContent = `Events: ${session.getEventCount()}`;
      checkpointCount.textContent = `Checkpoints: ${session.getCheckpoints().length}`;
      lastCloudOk = true;
      startAutoExportTimer();
      console.log(`[thesis] Recovered session with ${session.getEventCount()} events`);
    } else {
      // No prior session for this file — auto-start a fresh one so a
      // collaborator who lands on the URL and starts typing has their
      // authorship signed from the first keystroke, without needing to
      // remember to click Start Session first.
      await session.start(() => yText.toString());
      lastCloudOk = true;
      startAutoExportTimer();
      console.log(`[thesis] Auto-started fresh session for #${SLICE1_FILE_ID}`);
    }

    // Enable capture now that recovery / auto-start is done
    setCaptureEnabled(true);
  } catch (err) {
    console.error('[thesis] Recovery failed:', err);
    // Enable capture anyway so new sessions work
    setCaptureEnabled(true);
  }
})();

// ─── Tab switching ─────────────────────────────────────────────────

function switchTab(tab: TabName): void {
  activeTab = tab;

  tabsEl.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.textContent === tab);
  });

  editorPanel.classList.toggle('active', tab === 'Editor');
  replayView.getElement().classList.toggle('active', tab === 'Replay');
  verifyPanel.classList.toggle('active', tab === 'Verify');
}
