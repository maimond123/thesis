import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { ProofFile } from '../types';
import { createEditor } from '../editor/setup';
import { ReplayEngine } from './replay-engine';

export class ReplayView {
  private container: HTMLElement;
  private editorContainer: HTMLElement;
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
    this.playBtn.className = 'btn';
    this.playBtn.textContent = 'Play';
    this.playBtn.disabled = true;
    this.playBtn.addEventListener('click', () => this.togglePlay());

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => this.engine?.stop());

    // Speed buttons
    const speeds = [0.5, 1, 2, 4, 8];
    const speedGroup = document.createElement('div');
    speedGroup.style.display = 'flex';
    speedGroup.style.gap = '4px';

    for (const s of speeds) {
      const btn = document.createElement('button');
      btn.className = `speed-btn${s === 1 ? ' active' : ''}`;
      btn.textContent = `${s}x`;
      btn.addEventListener('click', () => {
        speedGroup.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.engine?.setSpeed(s);
      });
      speedGroup.appendChild(btn);
    }

    // Progress bar
    const progress = document.createElement('div');
    progress.className = 'replay-progress';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'replay-progress-fill';
    this.progressFill.style.width = '0%';
    progress.appendChild(this.progressFill);

    progress.addEventListener('click', (e) => {
      if (!this.engine) return;
      const rect = progress.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const index = Math.floor(ratio * this.engine.total);
      this.engine.seekTo(index);
    });

    this.timeLabel = document.createElement('span');
    this.timeLabel.className = 'replay-time';
    this.timeLabel.textContent = '0 / 0';

    controls.appendChild(this.playBtn);
    controls.appendChild(stopBtn);
    controls.appendChild(speedGroup);
    controls.appendChild(progress);
    controls.appendChild(this.timeLabel);

    // Editor area
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container';

    // Empty state
    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.textContent = 'Import a proof file to replay the writing process';

    this.container.appendChild(controls);
    this.container.appendChild(this.editorContainer);
    this.container.appendChild(this.emptyState);
    parent.appendChild(this.container);
  }

  loadProof(proof: ProofFile): void {
    this.emptyState.style.display = 'none';
    this.editorContainer.style.display = 'block';
    this.editorContainer.innerHTML = '';

    // Replay needs its own isolated Y.Doc so it doesn't share state with the
    // live editor in the Editor tab. y-codemirror requires a Y.Text + Awareness
    // even in read-only mode.
    const replayDoc = new Y.Doc();
    const replayText = replayDoc.getText('main');
    const replayAwareness = new Awareness(replayDoc);
    const view = createEditor(this.editorContainer, replayText, replayAwareness, [], true);

    this.engine = new ReplayEngine(proof.events);
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
