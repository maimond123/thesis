import type { ProofFile } from '../types';
import { importFromFile } from '../export/importer';
import { verifyProof, type VerificationResult } from './verifier';

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

    // Human pattern analysis
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
}
