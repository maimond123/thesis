import { createEditor } from './editor/setup';
import { keystrokeCaptureExtension } from './editor/keystroke-plugin';
import { SessionManager } from './session/session-manager';
import { downloadProof } from './export/exporter';
import { importFromFile } from './export/importer';
import { ReplayView } from './replay/replay-view';
import { VerifyUI } from './verification/verify-ui';
import { anchorHashOnChain, explorerUrl, chainName } from './crypto/ethereum';
import type { ProofFile } from './types';

// ─── State ─────────────────────────────────────────────────────────

const session = new SessionManager();
let editorView: ReturnType<typeof createEditor> | null = null;
let lastProof: ProofFile | null = null;
let replayView: ReplayView;

// ─── Build DOM ─────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>('#app')!;

// Header
const header = document.createElement('div');
header.className = 'header';
header.innerHTML = `<span class="header-title">thesis</span>`;
app.appendChild(header);

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
app.appendChild(toolbar);

// View container
const viewContainer = document.createElement('div');
viewContainer.className = 'view-container';

// Editor panel
const editorPanel = document.createElement('div');
editorPanel.className = 'view-panel active';
editorPanel.id = 'editor-panel';

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

app.appendChild(viewContainer);

// Commit hash display (below toolbar when visible)
app.insertBefore(commitHashEl, viewContainer);

// Status bar
const statusBar = document.createElement('div');
statusBar.className = 'status-bar';

const statusDot = document.createElement('span');
statusDot.className = 'status-dot idle';

const statusText = document.createElement('span');
statusText.textContent = 'Idle';

const eventCount = document.createElement('span');
eventCount.className = 'status-item';
eventCount.textContent = 'Events: 0';

const checkpointCount = document.createElement('span');
checkpointCount.className = 'status-item';
checkpointCount.textContent = 'Checkpoints: 0';

const cloudStatus = document.createElement('span');
cloudStatus.className = 'status-item';
cloudStatus.textContent = '';

statusBar.appendChild(document.createElement('span')).appendChild(statusDot);
statusBar.querySelector('span')!.classList.add('status-item');
statusBar.querySelector('.status-item')!.appendChild(statusText);
statusBar.appendChild(eventCount);
statusBar.appendChild(checkpointCount);
statusBar.appendChild(cloudStatus);
app.appendChild(statusBar);

// ─── Create editor ─────────────────────────────────────────────────

// Capture gating — disabled during recovery to avoid duplicate events
let setCaptureEnabled: (v: boolean) => void = () => {};
let isCaptureEnabled: () => boolean = () => true;

const captureExtension = keystrokeCaptureExtension((raw) => {
  if (!isCaptureEnabled()) return;
  session.handleEvent(raw);
});

editorView = createEditor(editorContainer, [captureExtension]);

// ─── Session callbacks ─────────────────────────────────────────────

session.onEventAdded = (count) => {
  eventCount.textContent = `Events: ${count}`;
};

session.onCloudSync = (status, message) => {
  if (status === 'saving') cloudStatus.textContent = 'Cloud: saving...';
  else if (status === 'saved') {
    cloudStatus.textContent = 'Cloud: saved';
    setTimeout(() => { if (cloudStatus.textContent === 'Cloud: saved') cloudStatus.textContent = ''; }, 3000);
  }
  else if (status === 'error') {
    cloudStatus.textContent = `Cloud: error`;
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
};

// ─── Button handlers ───────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  if (!editorView) return;

  // Clear editor
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: '' },
  });

  await session.start(() => editorView!.state.doc.toString());

  eventCount.textContent = 'Events: 0';
  checkpointCount.textContent = 'Checkpoints: 0';
  commitHashEl.style.display = 'none';
  lastProof = null;
  exportBtn.disabled = true;
});

endBtn.addEventListener('click', async () => {
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
            () => editorView!.state.doc.toString(),
            (doc) => {
              editorView!.dispatch({
                changes: { from: 0, to: editorView!.state.doc.length, insert: doc },
              });
            },
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
      () => editorView!.state.doc.toString(),
      (doc) => {
        editorView!.dispatch({
          changes: { from: 0, to: editorView!.state.doc.length, insert: doc },
        });
      },
    );
    if (recovered) {
      eventCount.textContent = `Events: ${session.getEventCount()}`;
      checkpointCount.textContent = `Checkpoints: ${session.getCheckpoints().length}`;
      console.log(`[thesis] Recovered session with ${session.getEventCount()} events`);
    }

    // Enable capture now that recovery is done
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
