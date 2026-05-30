import type { ProofFile } from '../types';
import { importFromFile } from '../export/importer';
import {
  verifyProof,
  type VerificationResult,
  type AuthoringActivity,
  type CommentsVerificationSummary,
  DELAY_BUCKETS,
  formatDuration,
} from './verifier';

export class VerifyUI {
  private container: HTMLElement;
  private resultsEl: HTMLElement;
  private onProofLoaded?: (proof: ProofFile) => void;

  constructor(parent: HTMLElement, onProofLoaded?: (proof: ProofFile) => void) {
    this.onProofLoaded = onProofLoaded;
    this.container = document.createElement('div');
    this.container.className = 'verify-container';

    // Drop zone
    const dropZone = document.createElement('div');
    dropZone.className = 'drop-zone';
    dropZone.innerHTML = `
      <div class="drop-zone-text">Drop a .proof.json file here</div>
      <div class="drop-zone-sub">or click to browse</div>
    `;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.style.display = 'none';

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer?.files[0];
      if (file) this.handleFile(file);
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.handleFile(file);
    });

    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'verify-results';

    this.container.appendChild(dropZone);
    this.container.appendChild(fileInput);
    this.container.appendChild(this.resultsEl);
    parent.appendChild(this.container);
  }

  private async handleFile(file: File): Promise<void> {
    this.resultsEl.innerHTML = '';
    this.addCheck('info', 'Loading...', `Parsing ${file.name}`);

    try {
      const proof = await importFromFile(file);
      this.resultsEl.innerHTML = '';
      this.addCheck('info', 'File loaded', `Session ${proof.session.sessionId.slice(0, 8)}... | ${proof.events.length} events`);

      this.addCheck('info', 'Verifying...', 'Running all cryptographic checks');
      const result = await verifyProof(proof);
      this.resultsEl.innerHTML = '';
      this.renderResults(result, proof);

      this.onProofLoaded?.(proof);
    } catch (err) {
      this.resultsEl.innerHTML = '';
      this.addCheck('fail', 'Import failed', String(err));
    }
  }

  private renderResults(result: VerificationResult, proof: ProofFile): void {
    const { checks } = result;

    // Overall verdict
    this.addCheck(
      result.valid ? 'pass' : 'fail',
      result.valid ? 'PROOF VALID' : 'PROOF INVALID',
      result.valid
        ? 'All cryptographic checks passed'
        : 'One or more checks failed — see details below'
    );

    // Individual checks
    this.addCheck(
      checks.genesisHash.passed ? 'pass' : 'fail',
      checks.genesisHash.message,
      checks.genesisHash.details
    );

    this.addCheck(
      checks.hashChain.passed ? 'pass' : 'fail',
      checks.hashChain.message,
      checks.hashChain.details
    );

    this.addCheck(
      checks.checkpointSignatures.passed ? 'pass' : 'fail',
      checks.checkpointSignatures.message,
      checks.checkpointSignatures.details
    );

    this.addCheck(
      checks.documentConsistency.passed ? 'pass' : 'fail',
      checks.documentConsistency.message,
      checks.documentConsistency.details
    );

    this.addCheck(
      checks.finalSignature.passed ? 'pass' : 'fail',
      checks.finalSignature.message,
      checks.finalSignature.details
    );

    this.addCheck(
      checks.roster.passed ? 'pass' : 'fail',
      checks.roster.message,
      checks.roster.details,
    );

    // Authors roster — display each contributing author with their handle and short thumbprint.
    if (proof.session.authors && proof.session.authors.length > 0) {
      const lines = proof.session.authors.map((a) => `${a.handle}  (${a.thumbprint.slice(0, 8)}…${a.thumbprint.slice(-4)})`);
      this.addCheck('info', `Authors (${proof.session.authors.length})`, lines.join('\n'));
    }

    // Authoring activity — pure statistics, no human-vs-AI verdict. Authorship
    // attribution is the cryptographic chain above; this panel is descriptive.
    const aa = checks.authoringActivity;
    const lines: string[] = [];
    const typedPasted = `Events: ${aa.totalEvents}  (typed ${aa.typedEvents}, pasted ${aa.pasteEvents})`;
    lines.push(typedPasted);
    if (aa.pasteEvents > 0) {
      const avg = Math.round(aa.pastedChars / aa.pasteEvents);
      lines.push(`Pasted ${aa.pastedChars} chars across ${aa.pasteEvents} paste${aa.pasteEvents === 1 ? '' : 's'} (avg ${avg} chars)`);
    }
    if (aa.calendarSpanMs !== null) {
      const sessionsLabel = aa.sessions !== null && aa.sessions > 1
        ? ` across ${aa.sessions} sessions`
        : '';
      lines.push(`Calendar span: ${formatDuration(aa.calendarSpanMs)}${sessionsLabel}`);
    } else if (aa.totalEvents > 0) {
      lines.push('Calendar span: unknown (proof predates wall-clock timestamps)');
    }
    if (aa.activeWritingMs !== null) {
      lines.push(`Active writing: ${formatDuration(aa.activeWritingMs)}`);
    }
    lines.push(`Median inter-keystroke gap: ${aa.medianGapMs}ms (std dev ${aa.gapStdDevMs}ms)`);
    if (aa.authors.length > 1) {
      const perAuthor = aa.authors
        .map((a) => {
          const handle = proof.session.authors?.find((x) => x.thumbprint === a.thumbprint)?.handle
            ?? `${a.thumbprint.slice(0, 6)}…`;
          const active = formatDuration(a.activeMs);
          const pasteNote = a.pastes > 0 ? `, ${a.pastes} paste${a.pastes === 1 ? '' : 's'}` : '';
          return `  ${handle}: ${a.events} events, ${active} active${pasteNote}`;
        })
        .join('\n');
      lines.push(`By author:\n${perAuthor}`);
    }
    this.addCheck('info', 'Authoring activity', lines.join('\n'));
    this.renderActivityProfile(aa);

    // Comments section — render only when the proof has any. Each comment
    // shows its author, body, and per-signature pass/fail. A tampered
    // body flags exactly that comment.
    if (checks.comments.details !== null) {
      this.renderCommentsSection(checks.comments, proof);
    }

    // Session info
    this.addCheck(
      'info',
      'Session info',
      `ID: ${proof.session.sessionId}\n` +
      `Start: ${proof.session.startTime}\n` +
      `End: ${proof.session.endTime}\n` +
      `Events: ${proof.events.length} | Checkpoints: ${proof.checkpoints.length}`
    );
  }

  private addCheck(type: 'pass' | 'fail' | 'info', label: string, detail?: string): void {
    const el = document.createElement('div');
    el.className = `verify-check ${type}`;

    const icons: Record<string, string> = { pass: '\u2713', fail: '\u2717', info: '\u2022' };
    el.innerHTML = `
      <span class="verify-icon">${icons[type]}</span>
      <div>
        <div class="verify-label">${label}</div>
        ${detail ? `<div class="verify-detail">${detail}</div>` : ''}
      </div>
    `;

    this.resultsEl.appendChild(el);
  }

  private renderActivityProfile(aa: AuthoringActivity): void {
    if (aa.totalEvents < 2) return;

    const card = document.createElement('div');
    card.className = 'humanness-card';

    // \u2500\u2500 Inter-keystroke gap histogram \u2500\u2500
    const histTitle = document.createElement('div');
    histTitle.className = 'humanness-section-title';
    histTitle.textContent = 'Inter-keystroke gap distribution';
    card.appendChild(histTitle);

    const histDesc = document.createElement('div');
    histDesc.className = 'humanness-section-sub';
    histDesc.textContent = 'How long the writer paused between keystrokes (intra-page only \u2014 gaps across page reloads are excluded).';
    card.appendChild(histDesc);

    const histRow = document.createElement('div');
    histRow.className = 'humanness-histogram';
    const maxCount = Math.max(1, ...aa.delayHistogram);
    for (let i = 0; i < DELAY_BUCKETS.length; i++) {
      const count = aa.delayHistogram[i];
      const pct = (count / maxCount) * 100;
      const col = document.createElement('div');
      col.className = 'humanness-bar-col';
      col.innerHTML = `
        <div class="humanness-bar-value">${count}</div>
        <div class="humanness-bar" style="height:${Math.max(2, pct)}%" title="${DELAY_BUCKETS[i].label}: ${count} events"></div>
        <div class="humanness-bar-label">${escapeHtml(DELAY_BUCKETS[i].label)}</div>
      `;
      histRow.appendChild(col);
    }
    card.appendChild(histRow);

    // \u2500\u2500 Paste timeline \u2500\u2500
    const pasteTitle = document.createElement('div');
    pasteTitle.className = 'humanness-section-title';
    pasteTitle.style.marginTop = '20px';
    pasteTitle.textContent = `Paste events (${aa.pasteSpikes.length})`;
    card.appendChild(pasteTitle);

    const pasteDesc = document.createElement('div');
    pasteDesc.className = 'humanness-section-sub';
    pasteDesc.textContent = aa.pasteSpikes.length === 0
      ? 'No paste operations recorded \u2014 every character was typed.'
      : `Each spike is one paste, plotted by when it landed in the session timeline. Height scales with paste length.`;
    card.appendChild(pasteDesc);

    if (aa.pasteSpikes.length > 0) {
      const timeline = document.createElement('div');
      timeline.className = 'humanness-paste-timeline';
      const maxLen = Math.max(...aa.pasteSpikes.map((p) => p.length), 1);
      // Prefer wallClock for the x-axis when it's available (works across
      // page reloads); fall back to performance.now() timestamp for legacy
      // proofs where wallClock isn't set.
      const x = (p: typeof aa.pasteSpikes[number]) => p.wallClock ?? p.timestamp;
      const minT = Math.min(...aa.pasteSpikes.map(x));
      const maxT = Math.max(...aa.pasteSpikes.map(x));
      const span = Math.max(1, maxT - minT);
      for (const sp of aa.pasteSpikes) {
        const left = ((x(sp) - minT) / span) * 100;
        const heightPct = (sp.length / maxLen) * 100;
        const spike = document.createElement('div');
        spike.className = 'humanness-paste-spike';
        spike.style.left = `${left}%`;
        spike.style.height = `${Math.max(8, heightPct)}%`;
        spike.title = `${sp.length} chars by ${sp.authorThumbprint.slice(0, 8)}\u2026`;
        timeline.appendChild(spike);
      }
      card.appendChild(timeline);
    }

    this.resultsEl.appendChild(card);
  }

  private renderCommentsSection(summary: CommentsVerificationSummary, proof: ProofFile): void {
    const card = document.createElement('div');
    card.className = 'humanness-card';
    const title = document.createElement('div');
    title.className = 'humanness-section-title';
    const allOk = summary.failed === 0;
    title.textContent = allOk
      ? `Comments (${summary.passed} verified)`
      : `Comments (${summary.passed} verified, ${summary.failed} FAILED)`;
    card.appendChild(title);

    if (!proof.comments) { this.resultsEl.appendChild(card); return; }

    // Group by thread for display. Threads ordered by createdAt.
    const threads = [...proof.comments.threads].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    const commentResultById = new Map(summary.details?.map((d) => [d.comment.id, d]) ?? []);

    for (const t of threads) {
      const block = document.createElement('div');
      block.className = `verify-comment-thread${t.resolved ? ' resolved' : ''}`;

      const head = document.createElement('div');
      head.className = 'verify-comment-head';
      head.innerHTML = `
        <span>Thread ${t.id.slice(0, 8)}</span>
        <span class="verify-comment-state">${t.resolved ? 'resolved' : 'open'}</span>
      `;
      block.appendChild(head);

      const threadComments = proof.comments.comments
        .filter((c) => c.threadId === t.id)
        .sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
      for (const c of threadComments) {
        const res = commentResultById.get(c.id);
        const ok = res?.valid ?? false;
        const ind = document.createElement('div');
        ind.className = `verify-comment-row ${ok ? 'pass' : 'fail'}`;
        const timestamp = escapeHtml(new Date(c.createdAt).toLocaleString());
        const reason = res?.reason ? ` — ${escapeHtml(res.reason)}` : '';
        ind.innerHTML = `
          <span class="verify-comment-icon">${ok ? '✓' : '✗'}</span>
          <div>
            <div class="verify-comment-meta"><strong>${escapeHtml(c.authorHandle)}</strong> · ${timestamp}${reason}</div>
            <div class="verify-comment-body">${escapeHtml(c.body)}</div>
          </div>
        `;
        block.appendChild(ind);
      }
      card.appendChild(block);
    }
    this.resultsEl.appendChild(card);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
