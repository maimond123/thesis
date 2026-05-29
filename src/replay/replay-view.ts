import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { ProofFile } from '../types';
import { createEditor } from '../editor/setup';
import { ReplayEngine } from './replay-engine';
import { authorDecorationExtension } from './author-decoration';

// Number of distinct author colors supported. Beyond this, late-joining
// authors cycle through the same palette — fine for a 2-3 person thesis.
const PALETTE_SIZE = 6;

export class ReplayView {
  private container: HTMLElement;
  private editorContainer: HTMLElement;
  private legendEl: HTMLElement;
  private engine: ReplayEngine | null = null;
  private progressFill: HTMLElement;
  private timeLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private emptyState: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'view-panel';
    this.container.id = 'replay-panel';

    // Controls bar
    const controls = document.createElement('div');
    controls.className = 'replay-controls';

    this.playBtn = document.createElement('button');
    this.playBtn.className = 'btn btn-primary';
    this.playBtn.textContent = 'Play';
    this.playBtn.disabled = true;
    this.playBtn.addEventListener('click', () => this.togglePlay());

    const progressWrap = document.createElement('div');
    progressWrap.className = 'replay-progress';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'replay-progress-fill';
    progressWrap.appendChild(this.progressFill);

    this.timeLabel = document.createElement('div');
    this.timeLabel.className = 'replay-time';
    this.timeLabel.textContent = '0 / 0';

    const speedGroup = document.createElement('div');
    speedGroup.style.display = 'flex';
    speedGroup.style.gap = '4px';
    for (const speed of [0.5, 1, 2, 5, 10]) {
      const btn = document.createElement('button');
      btn.className = `speed-btn ${speed === 1 ? 'active' : ''}`;
      btn.textContent = `${speed}x`;
      btn.addEventListener('click', () => {
        if (!this.engine) return;
        this.engine.setSpeed(speed);
        for (const b of speedGroup.querySelectorAll('.speed-btn')) b.classList.remove('active');
        btn.classList.add('active');
      });
      speedGroup.appendChild(btn);
    }

    controls.appendChild(this.playBtn);
    controls.appendChild(progressWrap);
    controls.appendChild(this.timeLabel);
    controls.appendChild(speedGroup);

    this.legendEl = document.createElement('div');
    this.legendEl.className = 'replay-legend';

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container';
    this.editorContainer.style.display = 'none';

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.textContent = 'Import a proof file to replay the writing process';

    this.container.appendChild(controls);
    this.container.appendChild(this.legendEl);
    this.container.appendChild(this.editorContainer);
    this.container.appendChild(this.emptyState);
    parent.appendChild(this.container);
  }

  loadProof(proof: ProofFile): void {
    this.emptyState.style.display = 'none';
    this.editorContainer.style.display = 'block';
    this.editorContainer.innerHTML = '';

    // Build author → palette index by first appearance in the events list so
    // the colour assignment is stable across reloads of the same proof.
    const authorIndex = new Map<string, number>();
    for (const ev of proof.events) {
      if (!authorIndex.has(ev.authorThumbprint)) {
        authorIndex.set(ev.authorThumbprint, authorIndex.size % PALETTE_SIZE);
      }
    }
    // Make sure roster-only authors (no events) still get an index so the
    // legend lists everyone.
    for (const a of proof.session.authors ?? []) {
      if (!authorIndex.has(a.thumbprint)) {
        authorIndex.set(a.thumbprint, authorIndex.size % PALETTE_SIZE);
      }
    }

    this.renderLegend(proof, authorIndex);

    const replayDoc = new Y.Doc();
    const replayText = replayDoc.getText('main');
    const replayAwareness = new Awareness(replayDoc);
    const view = createEditor(
      this.editorContainer,
      replayText,
      replayAwareness,
      [authorDecorationExtension()],
      true,
    );

    this.engine = new ReplayEngine(proof.events, authorIndex);
    this.engine.attachView(view);

    this.engine.onProgress = (index, total) => {
      const pct = total > 0 ? (index / total) * 100 : 0;
      this.progressFill.style.width = `${pct}%`;
      this.timeLabel.textContent = `${index} / ${total}`;
    };

    this.engine.onStateChange = (state) => {
      this.playBtn.textContent = state === 'playing' ? 'Pause' : 'Play';
    };

    this.playBtn.disabled = false;
    this.timeLabel.textContent = `0 / ${proof.events.length}`;
  }

  private renderLegend(proof: ProofFile, authorIndex: Map<string, number>): void {
    this.legendEl.innerHTML = '';
    const authorsByThumb = new Map((proof.session.authors ?? []).map((a) => [a.thumbprint, a]));
    for (const [thumb, idx] of authorIndex) {
      const a = authorsByThumb.get(thumb);
      const handle = a?.handle ?? `${thumb.slice(0, 6)}…${thumb.slice(-4)}`;
      const chip = document.createElement('span');
      chip.className = 'replay-legend-item';
      chip.innerHTML = `<span class="replay-legend-swatch cm-author-${idx}"></span><span>${escapeHtml(handle)}</span>`;
      this.legendEl.appendChild(chip);
    }
  }

  private togglePlay(): void {
    if (!this.engine) return;
    if (this.engine.state === 'playing') {
      this.engine.pause();
    } else {
      this.engine.play();
    }
  }

  getElement(): HTMLElement {
    return this.container;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
