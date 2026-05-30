import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import type { ProofFile, AuthoringEvent } from '../types';
import { createEditor } from '../editor/setup';
import { ReplayEngine } from './replay-engine';
import { authorDecorationExtension, addAuthorMark, clearAuthorMarks } from './author-decoration';
import { base64ToBytes } from '../editor/yjs-bytes';

const PALETTE_SIZE = 6;
type Mode = 'unified' | 'tracks';

// One contained editor surface — either the single unified editor in
// 'unified' mode, or one of the per-author editors in 'tracks' mode.
interface Surface {
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  view: EditorView;
  container: HTMLElement;
  authorThumbprint?: string;   // set in tracks mode
}

export class ReplayView {
  private container: HTMLElement;
  private surfaceHost: HTMLElement;
  private legendEl: HTMLElement;
  private progressFill: HTMLElement;
  private timeLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private emptyState: HTMLElement;
  private modeBtn: HTMLButtonElement;

  private engine: ReplayEngine | null = null;
  private mode: Mode = 'unified';
  private proof: ProofFile | null = null;
  private authorIndex: Map<string, number> = new Map();
  private currentSpeed = 1;

  // Active surfaces — 1 entry in unified, N in tracks.
  private surfaces: Surface[] = [];
  private surfaceByAuthor: Map<string, Surface> = new Map();

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
    progressWrap.tabIndex = 0;
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'replay-progress-fill';
    progressWrap.appendChild(this.progressFill);

    const seekFromEvent = (e: MouseEvent) => {
      if (!this.engine || this.engine.total === 0) return;
      const rect = progressWrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, x / rect.width));
      this.engine.seekTo(Math.round(fraction * this.engine.total));
    };
    let scrubbing = false;
    progressWrap.addEventListener('mousedown', (e) => {
      scrubbing = true;
      seekFromEvent(e);
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (scrubbing) seekFromEvent(e); });
    window.addEventListener('mouseup', () => { scrubbing = false; });
    progressWrap.addEventListener('keydown', (e) => {
      if (!this.engine) return;
      if (e.key === 'ArrowLeft') {
        this.engine.seekTo(Math.max(0, this.engine.current - (e.shiftKey ? 25 : 1)));
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        this.engine.seekTo(Math.min(this.engine.total, this.engine.current + (e.shiftKey ? 25 : 1)));
        e.preventDefault();
      } else if (e.key === 'Home') { this.engine.seekTo(0); e.preventDefault(); }
      else if (e.key === 'End') { this.engine.seekTo(this.engine.total); e.preventDefault(); }
    });

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
        this.currentSpeed = speed;
        this.engine?.setSpeed(speed);
        for (const b of speedGroup.querySelectorAll('.speed-btn')) b.classList.remove('active');
        btn.classList.add('active');
      });
      speedGroup.appendChild(btn);
    }

    this.modeBtn = document.createElement('button');
    this.modeBtn.className = 'btn replay-mode-btn';
    this.modeBtn.type = 'button';
    this.modeBtn.textContent = 'Per-author tracks';
    this.modeBtn.title = 'Toggle between unified (CRDT-merged) replay and one editor per author';
    this.modeBtn.addEventListener('click', () => {
      if (!this.proof) return;
      this.setMode(this.mode === 'unified' ? 'tracks' : 'unified');
    });

    controls.appendChild(this.playBtn);
    controls.appendChild(progressWrap);
    controls.appendChild(this.timeLabel);
    controls.appendChild(speedGroup);
    controls.appendChild(this.modeBtn);

    this.legendEl = document.createElement('div');
    this.legendEl.className = 'replay-legend';

    this.surfaceHost = document.createElement('div');
    this.surfaceHost.className = 'editor-container';
    this.surfaceHost.style.display = 'none';

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.textContent = 'Import a proof file to replay the writing process';

    this.container.appendChild(controls);
    this.container.appendChild(this.legendEl);
    this.container.appendChild(this.surfaceHost);
    this.container.appendChild(this.emptyState);
    parent.appendChild(this.container);
  }

  loadProof(proof: ProofFile): void {
    this.proof = proof;
    this.emptyState.style.display = 'none';
    this.surfaceHost.style.display = 'flex';

    // Stable per-author color index by first appearance + roster fallback.
    this.authorIndex = new Map();
    for (const ev of proof.events) {
      if (!this.authorIndex.has(ev.authorThumbprint)) {
        this.authorIndex.set(ev.authorThumbprint, this.authorIndex.size % PALETTE_SIZE);
      }
    }
    for (const a of proof.session.authors ?? []) {
      if (!this.authorIndex.has(a.thumbprint)) {
        this.authorIndex.set(a.thumbprint, this.authorIndex.size % PALETTE_SIZE);
      }
    }

    this.renderLegend(proof, this.authorIndex);
    this.setMode(this.mode); // (re)builds surfaces and engine

    this.playBtn.disabled = false;
    this.timeLabel.textContent = `0 / ${proof.events.length}`;
  }

  private setMode(mode: Mode): void {
    if (!this.proof) return;
    this.mode = mode;
    this.modeBtn.textContent = mode === 'unified' ? 'Per-author tracks' : 'Unified replay';
    this.surfaceHost.classList.toggle('replay-surface-tracks', mode === 'tracks');

    // Tear down any existing surfaces + engine.
    this.engine?.pause();
    this.tearDownSurfaces();

    if (mode === 'unified') {
      const surface = this.buildSurface(this.surfaceHost);
      this.surfaces = [surface];
    } else {
      // One mini-editor per author with events, ordered by first-appearance.
      const seen = new Set<string>();
      const orderedAuthors: string[] = [];
      for (const ev of this.proof.events) {
        if (!seen.has(ev.authorThumbprint)) {
          seen.add(ev.authorThumbprint);
          orderedAuthors.push(ev.authorThumbprint);
        }
      }
      for (const thumb of orderedAuthors) {
        const trackWrap = document.createElement('div');
        trackWrap.className = 'replay-track';
        const head = document.createElement('div');
        head.className = 'replay-track-head';
        const swatch = document.createElement('span');
        const idx = this.authorIndex.get(thumb) ?? 0;
        swatch.className = `replay-legend-swatch cm-author-${idx}`;
        const author = this.proof.session.authors?.find((a) => a.thumbprint === thumb);
        const label = document.createElement('span');
        label.textContent = author?.handle ?? `${thumb.slice(0, 6)}…${thumb.slice(-4)}`;
        head.appendChild(swatch);
        head.appendChild(label);
        const body = document.createElement('div');
        body.className = 'replay-track-body';
        trackWrap.appendChild(head);
        trackWrap.appendChild(body);
        this.surfaceHost.appendChild(trackWrap);
        const surface = this.buildSurface(body, thumb);
        this.surfaces.push(surface);
        this.surfaceByAuthor.set(thumb, surface);
      }
    }

    // Engine drives time + routes events; the surfaces handle the actual edits.
    const engine = new ReplayEngine(
      this.proof.events,
      (event) => this.dispatchEvent(event),
      () => this.resetSurfaces(),
    );
    engine.setSpeed(this.currentSpeed);
    engine.onProgress = (index, total) => {
      const pct = total > 0 ? (index / total) * 100 : 0;
      this.progressFill.style.width = `${pct}%`;
      this.timeLabel.textContent = `${index} / ${total}`;
    };
    engine.onStateChange = (state) => {
      this.playBtn.textContent = state === 'playing' ? 'Pause' : 'Play';
    };
    this.engine = engine;
    this.timeLabel.textContent = `0 / ${this.proof.events.length}`;
  }

  // Build a single editor surface bound to a fresh Y.Doc. In unified mode this
  // hosts the CRDT-correct replay; in tracks mode each surface hosts one
  // author's events using the legacy position-based path.
  private buildSurface(container: HTMLElement, authorThumbprint?: string): Surface {
    container.innerHTML = '';
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('main');
    const awareness = new Awareness(ydoc);

    // Author-mark dispatcher for unified mode: when a Yjs update is applied
    // (Transaction.remote === true), tag the new range with the colour of the
    // author currently being applied.
    const authorMarkExt = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const thumb = this.engine?.currentAuthorThumbprint;
      if (!thumb) return;
      const idx = this.authorIndex.get(thumb);
      if (idx === undefined) return;
      for (const tr of update.transactions) {
        if (!tr.annotation(Transaction.remote)) continue;
        tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          if (toB > fromB) {
            update.view.dispatch({
              effects: addAuthorMark.of({ from: fromB, to: toB, authorIndex: idx }),
            });
          }
        });
      }
    });

    const view = createEditor(
      container,
      ytext,
      awareness,
      [authorDecorationExtension(), authorMarkExt],
      true,
    );
    return { ydoc, ytext, awareness, view, container, authorThumbprint };
  }

  private dispatchEvent(event: AuthoringEvent): void {
    if (!this.engine) return;
    if (this.mode === 'unified') {
      const surface = this.surfaces[0];
      if (!surface) return;
      if (event.yjsUpdate) {
        // CRDT-correct path — replay the exact Yjs binary the author produced.
        // Setting currentAuthorThumbprint before applyUpdateV2 lets the editor's
        // updateListener tag the resulting inserted range with the author's colour.
        this.engine.currentAuthorThumbprint = event.authorThumbprint;
        try {
          Y.applyUpdateV2(surface.ydoc, base64ToBytes(event.yjsUpdate));
        } finally {
          this.engine.currentAuthorThumbprint = null;
        }
      } else {
        // Legacy path for older proofs / single-author chains without a Yjs blob.
        this.applyEventLegacy(event, surface.view);
      }
    } else {
      // tracks mode: route to that author's mini-editor (legacy path, since
      // each author's chain is internally consistent in their local view).
      const surface = this.surfaceByAuthor.get(event.authorThumbprint);
      if (!surface) return;
      this.applyEventLegacy(event, surface.view);
    }
  }

  private applyEventLegacy(event: AuthoringEvent, view: EditorView): void {
    if (event.inserted === '' && event.deleted === '') return;
    const idx = this.authorIndex.get(event.authorThumbprint) ?? 0;
    const effects =
      event.inserted.length > 0
        ? [addAuthorMark.of({
            from: event.from,
            to: event.from + event.inserted.length,
            authorIndex: idx,
          })]
        : [];
    view.dispatch({
      changes: {
        from: event.from,
        to: event.from + event.deleted.length,
        insert: event.inserted,
      },
      effects,
      selection: { anchor: event.cursorAfter },
    });
  }

  // Hard-reset every surface to an empty Y.Doc + cleared editor. Used on
  // seek-to-zero and at the start of seekTo before re-playing forward.
  private resetSurfaces(): void {
    // We rebuild rather than try to "undo" Yjs operations — Yjs updates can't
    // be cleanly inverted, so swapping in a fresh doc is the safest path.
    const containers = this.surfaces.map((s) => ({ container: s.container, thumb: s.authorThumbprint }));
    this.tearDownSurfaces();
    if (this.mode === 'unified') {
      this.surfaces = [this.buildSurface(containers[0]?.container ?? this.surfaceHost)];
    } else {
      for (const c of containers) {
        const surface = this.buildSurface(c.container, c.thumb);
        this.surfaces.push(surface);
        if (c.thumb) this.surfaceByAuthor.set(c.thumb, surface);
      }
    }
  }

  private tearDownSurfaces(): void {
    for (const s of this.surfaces) {
      try { s.view.dispatch({ effects: clearAuthorMarks.of(undefined) }); } catch { /* ok */ }
      s.view.destroy();
      s.ydoc.destroy();
    }
    this.surfaces = [];
    this.surfaceByAuthor.clear();
    // Tracks mode adds wrappers around editor containers — clean those out too.
    if (this.mode === 'tracks') this.surfaceHost.innerHTML = '';
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
    if (this.engine.state === 'playing') this.engine.pause();
    else this.engine.play();
  }

  getElement(): HTMLElement {
    return this.container;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
