import type { ProofFile } from '../types';
import { importFromFile } from '../export/importer';
import { verifyProof, type VerificationResult, DELAY_BUCKETS, type PatternAnalysis } from './verifier';

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

    // Human pattern analysis — summary line then visual profile.
    const hp = checks.humanPatterns;
    this.addCheck(
      hp.appearsHuman ? 'pass' : 'info',
      hp.appearsHuman ? 'Human authorship likely' : 'Human authorship inconclusive',
      `${hp.explanation}\n` +
      `Speed: ~${hp.averageSpeed} events/min | ` +
      `Median delay: ${hp.medianDelay}ms | ` +
      `Corrections: ${(hp.correctionRatio * 100).toFixed(1)}% | ` +
      `Thinking pauses: ${hp.longPauses}`
    );
    this.renderHumannessProfile(hp);

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

  private renderHumannessProfile(hp: PatternAnalysis): void {
    if (hp.totalEvents < 2) return;

    const card = document.createElement('div');
    card.className = 'humanness-card';

    // \u2500\u2500 Inter-keystroke gap histogram \u2500\u2500
    const histTitle = document.createElement('div');
    histTitle.className = 'humanness-section-title';
    histTitle.textContent = 'Inter-keystroke gap distribution';
    card.appendChild(histTitle);

    const histDesc = document.createElement('div');
    histDesc.className = 'humanness-section-sub';
    histDesc.textContent = 'Human typing has wide variance \u2014 a tall single-bucket distribution is a tell for replay/scripted input.';
    card.appendChild(histDesc);

    const histRow = document.createElement('div');
    histRow.className = 'humanness-histogram';
    const maxCount = Math.max(1, ...hp.delayHistogram);
    for (let i = 0; i < DELAY_BUCKETS.length; i++) {
      const count = hp.delayHistogram[i];
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
    pasteTitle.textContent = `Paste events (${hp.pasteSpikes.length})`;
    card.appendChild(pasteTitle);

    const pasteDesc = document.createElement('div');
    pasteDesc.className = 'humanness-section-sub';
    pasteDesc.textContent = hp.pasteSpikes.length === 0
      ? 'No paste operations recorded \u2014 every character was typed.'
      : 'Paste size and position in the session timeline. Large bulk pastes are the strongest anti-human signal.';
    card.appendChild(pasteDesc);

    if (hp.pasteSpikes.length > 0 && hp.sessionDurationMs > 0) {
      const timeline = document.createElement('div');
      timeline.className = 'humanness-paste-timeline';
      const maxLen = Math.max(...hp.pasteSpikes.map((p) => p.length), 1);
      const firstTs = hp.pasteSpikes[0].timestamp - (hp.pasteSpikes[0].timestamp - 0);
      // Map each spike onto a 0-100 horizontal position.
      // We use the session start (events[0].timestamp) as 0; we don't have
      // that here directly, so derive from the spikes themselves.
      const minT = Math.min(...hp.pasteSpikes.map((p) => p.timestamp));
      const maxT = Math.max(...hp.pasteSpikes.map((p) => p.timestamp), firstTs + hp.sessionDurationMs);
      const span = Math.max(1, maxT - minT);
      for (const sp of hp.pasteSpikes) {
        const left = ((sp.timestamp - minT) / span) * 100;
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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
