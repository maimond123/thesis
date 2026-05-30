import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorView } from '@codemirror/view';
import type { ProofFile, AuthoringEvent } from '../types';
import { createEditor } from '../editor/setup';
import { ReplayEngine } from './replay-engine';
import { authorDecorationExtension, addAuthorMark, clearAuthorMarks } from './author-decoration';
import { base64ToBytes } from '../editor/yjs-bytes';
import { CommentStore } from '../comments/comment-store';
import {
  commentDecorationExtension,
  buildAnchorPreviews,
  setThreadAnchors,
} from '../comments/decorations';
import type { CommentBundle } from '../comments/types';

const PALETTE_SIZE = 6;
type Mode = 'unified' | 'tracks';

// One bound (Y.Doc + Y.Text + read-only CodeMirror view) replay surface.
// authorThumbprint is set on a track surface (one author's events only);
// it's undefined on the merged surface (all events).
interface Surface {
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  view: EditorView;
  container: HTMLElement;
  authorThumbprint?: string;
  // Read-only CommentStore bound to this surface's Y.Doc. Loaded with the
  // proof's comment bundle (filtered to that author's authored comments on
  // a track surface) so the decoration extension can resolve anchors against
  // the same CRDT items the replay Y.Doc was reconstructed from. null when
  // the proof has no comments.
  commentStore?: CommentStore | null;
  // Tracks-mode-only counters. An event is "resolved" when applying its
  // yjsUpdate to this surface's Y.Doc grew/shrunk Y.Text by exactly the
  // (inserted.length - deleted.length) the author originally produced. It's
  // "buffered" when the change didn't fully land — which on a per-author
  // track means Yjs is waiting on a cross-author CRDT item that doesn't
  // exist in this isolated chain. Surfaced in the track header so reviewers
  // can tell at a glance whether a sparse-looking track is sparse because
  // of CRDT dependencies, not because the author barely contributed.
  appliedCount: number;
  resolvedCount: number;
  statusEl: HTMLElement | null;
}

// ReplayView owns:
//   * a merged surface — always present, shows the CRDT-correct merge of every
//     author's chain (the "what was actually on screen during the session" view)
//   * a tracks panel    — present only in 'tracks' mode, shows N read-only
//     mini-editors, one per author, each playing back that author's chain into
//     its own Y.Doc so the reviewer can see each contributor's solo work next
//     to the merge
//
// dispatchEvent fans an event out to BOTH the merged surface and (in tracks
// mode) the matching author's track surface. Per-track replay applies each
// author's yjsUpdates to a fresh Y.Doc — any cross-author CRDT dependency
// that's missing from that track gets buffered by Yjs (the track shows what
// resolves cleanly), which is the honest "this author's contribution in
// isolation" view we want for the side-by-side comparison.
export class ReplayView {
  private container: HTMLElement;
  private mergedHost: HTMLElement;
  private tracksHost: HTMLElement;
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

  private mergedSurface: Surface | null = null;
  private trackSurfaces: Surface[] = [];
  private trackByAuthor: Map<string, Surface> = new Map();

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'view-panel';
    this.container.id = 'replay-panel';

    // ── Controls bar ────────────────────────────────────────────────
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
    this.modeBtn.textContent = 'Show tracks';
    this.modeBtn.title = 'Show the per-author tracks panel below the merged view';
    this.modeBtn.addEventListener('click', () => {
      if (!this.proof) return;
      this.setMode(this.mode === 'unified' ? 'tracks' : 'unified');
    });

    controls.appendChild(this.playBtn);
    controls.appendChild(progressWrap);
    controls.appendChild(this.timeLabel);
    controls.appendChild(speedGroup);
    controls.appendChild(this.modeBtn);

    // ── Legend + surfaces ───────────────────────────────────────────
    this.legendEl = document.createElement('div');
    this.legendEl.className = 'replay-legend';

    // Merged surface host — always rendered. In tracks mode, CSS clamps its
    // height so the tracks panel below stays visible without scrolling.
    this.mergedHost = document.createElement('div');
    this.mergedHost.className = 'editor-container replay-merged-host';
    this.mergedHost.style.display = 'none';

    // Tracks panel host — only filled in 'tracks' mode, hidden in 'unified'.
    this.tracksHost = document.createElement('div');
    this.tracksHost.className = 'replay-tracks-host';
    this.tracksHost.style.display = 'none';

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'empty-state';
    this.emptyState.textContent = 'Import a proof file to replay the writing process';

    this.container.appendChild(controls);
    this.container.appendChild(this.legendEl);
    this.container.appendChild(this.mergedHost);
    this.container.appendChild(this.tracksHost);
    this.container.appendChild(this.emptyState);
    parent.appendChild(this.container);
  }

  loadProof(proof: ProofFile): void {
    this.proof = proof;
    this.emptyState.style.display = 'none';
    this.mergedHost.style.display = 'flex';

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
    this.modeBtn.textContent = mode === 'unified' ? 'Show tracks' : 'Hide tracks';
    this.container.classList.toggle('replay-mode-tracks', mode === 'tracks');

    this.engine?.pause();
    this.tearDownSurfaces();

    // Merged surface is always present, in both modes. Seed its CommentStore
    // with the full bundle (every author's comments) and push initial anchor
    // previews so threads show up immediately on load.
    this.mergedSurface = this.buildSurface(this.mergedHost);
    this.seedSurfaceComments(this.mergedSurface, this.proof.comments);

    if (mode === 'tracks') {
      this.tracksHost.style.display = 'flex';
      // One mini-editor per author with events, ordered by first appearance.
      const seen = new Set<string>();
      const orderedAuthors: string[] = [];
      for (const ev of this.proof.events) {
        if (!seen.has(ev.authorThumbprint)) {
          seen.add(ev.authorThumbprint);
          orderedAuthors.push(ev.authorThumbprint);
        }
      }
      const authorEventCounts = new Map<string, number>();
      for (const ev of this.proof.events) {
        authorEventCounts.set(ev.authorThumbprint, (authorEventCounts.get(ev.authorThumbprint) ?? 0) + 1);
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
        // Buffered/resolved hint — empty until at least one event is applied.
        const status = document.createElement('span');
        status.className = 'replay-track-status';
        status.dataset.total = String(authorEventCounts.get(thumb) ?? 0);
        head.appendChild(swatch);
        head.appendChild(label);
        head.appendChild(status);
        const body = document.createElement('div');
        body.className = 'replay-track-body';
        trackWrap.appendChild(head);
        trackWrap.appendChild(body);
        this.tracksHost.appendChild(trackWrap);
        const surface = this.buildSurface(body, thumb);
        surface.statusEl = status;
        // Per-author track: seed with comments filtered to threads the author owns.
        if (this.proof.comments) {
          const filtered = this.filterBundleForAuthor(this.proof.comments, thumb);
          this.seedSurfaceComments(surface, filtered);
        }
        this.trackSurfaces.push(surface);
        this.trackByAuthor.set(thumb, surface);
      }
    } else {
      this.tracksHost.style.display = 'none';
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

  // Filter the proof's comment bundle down to one author's authored
  // comments (and the threads those comments root). Used to seed a track
  // surface's read-only CommentStore so each track only shows the
  // comments by its own author. The "authored by X" filter is based on
  // each comment's authorThumbprint; threads anchor follows from the root
  // comment's author.
  private filterBundleForAuthor(
    bundle: CommentBundle,
    authorThumbprint: string,
  ): CommentBundle {
    const threadsByAuthor: typeof bundle.threads = [];
    const commentsByAuthor: typeof bundle.comments = [];
    for (const t of bundle.threads) {
      const root = bundle.comments.find((c) => c.id === t.rootCommentId);
      if (root && root.authorThumbprint === authorThumbprint) {
        threadsByAuthor.push(t);
      }
    }
    const includedThreadIds = new Set(threadsByAuthor.map((t) => t.id));
    for (const c of bundle.comments) {
      // Include the entire thread's comments if THIS author owns the thread.
      // (Track shows that author's thread + every reply on it, so reviewers
      // see context. Alternative: filter to comments authored by this author
      // only, but that loses reply context.)
      if (includedThreadIds.has(c.threadId)) commentsByAuthor.push(c);
    }
    return { threads: threadsByAuthor, comments: commentsByAuthor };
  }

  // Build a single editor surface bound to a fresh Y.Doc. Read-only; author
  // marks added via an updateListener that reads engine.currentAuthorThumbprint
  // each time y-codemirror dispatches a CM transaction in response to a
  // Y.Doc update we applied.
  private buildSurface(container: HTMLElement, authorThumbprint?: string): Surface {
    container.innerHTML = '';
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('main');
    const awareness = new Awareness(ydoc);

    // When the engine applies an event via Y.applyUpdateV2 it sets
    // currentAuthorThumbprint; y-codemirror's text observer then dispatches a
    // CM transaction reflecting the insert; this listener tags the new range
    // with the author's palette index. The currentAuthorThumbprint gate is
    // enough by itself (only the engine ever sets it, and only during apply),
    // so no annotation filter is needed.
    const authorMarkExt = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const thumb = this.engine?.currentAuthorThumbprint;
      if (!thumb) return;
      const idx = this.authorIndex.get(thumb);
      if (idx === undefined) return;
      for (const tr of update.transactions) {
        tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          if (toB > fromB) {
            update.view.dispatch({
              effects: addAuthorMark.of({ from: fromB, to: toB, authorIndex: idx }),
            });
          }
        });
      }
    });

    // Read-only CommentStore bound to this surface's Y.Doc. Filled below
    // once the surface is constructed and we know which comments to show.
    // identity=null = mutations throw, which is what we want for replay.
    const commentStore: CommentStore | null = this.proof?.comments
      ? new CommentStore(ydoc, ytext, null)
      : null;

    const authorIndexLookup = (thumb: string) => this.authorIndex.get(thumb) ?? 0;
    const extensions: import('@codemirror/state').Extension[] = [
      authorDecorationExtension(),
      authorMarkExt,
    ];
    if (commentStore) {
      // Comment decorations: underlines + click-to-no-op (no side panel in
      // Replay; the Verify tab is the source of truth for thread detail).
      extensions.push(
        commentDecorationExtension(commentStore, authorIndexLookup, () => {}),
      );
    }

    const view = createEditor(
      container,
      ytext,
      awareness,
      extensions,
      true,
    );
    return {
      ydoc, ytext, awareness, view, container, authorThumbprint,
      appliedCount: 0,
      resolvedCount: 0,
      statusEl: null,
      commentStore,
    };
  }

  private dispatchEvent(event: AuthoringEvent): void {
    if (!this.engine || !this.mergedSurface) return;

    // currentAuthorThumbprint stays set across both applies so both surfaces'
    // mark dispatchers (merged + track) see it on the synchronous CM update
    // y-codemirror fires in response.
    this.engine.currentAuthorThumbprint = event.authorThumbprint;
    try {
      this.applyTo(this.mergedSurface, event);
      if (this.mode === 'tracks') {
        const trackSurface = this.trackByAuthor.get(event.authorThumbprint);
        if (trackSurface) {
          const before = trackSurface.ytext.length;
          this.applyTo(trackSurface, event);
          const after = trackSurface.ytext.length;
          trackSurface.appliedCount += 1;
          const expected = event.inserted.length - event.deleted.length;
          if (after - before === expected) trackSurface.resolvedCount += 1;
          this.updateTrackStatus(trackSurface);
        }
      }
    } finally {
      this.engine.currentAuthorThumbprint = null;
    }
    // Anchors move with the doc; re-resolve and push updated previews onto
    // each surface's decoration state. Cheap relative to applyUpdateV2.
    //
    // Cutoff policy:
    //   * Final event of the timeline → Infinity. Comments often have
    //     createdAt > the last keystroke's wallClock (the writer added
    //     them after typing finished, or after end-of-session); we want
    //     them to show up at the end of replay, not stay hidden forever.
    //   * Any other event → that event's wallClock. Threads with
    //     createdAt <= cutoff are visible (the "scrubbed past their
    //     creation moment" state); later ones stay hidden.
    //
    // We use the event-vs-last check instead of consulting engine.current
    // because the engine increments currentIndex AFTER dispatchEvent
    // returns; reading it here would lag by one.
    const isLastEvent =
      this.proof && event === this.proof.events[this.proof.events.length - 1];
    const explicitCutoff = isLastEvent
      ? Number.POSITIVE_INFINITY
      : (event.wallClock
        ?? (this.proof ? Date.parse(this.proof.session.startTime) : 0));
    this.refreshAllCommentDecorations(explicitCutoff);
  }

  private updateTrackStatus(surface: Surface): void {
    if (!surface.statusEl) return;
    const total = Number(surface.statusEl.dataset.total ?? '0');
    const buffered = surface.appliedCount - surface.resolvedCount;
    surface.statusEl.textContent = buffered > 0
      ? `${surface.appliedCount}/${total} applied · ${buffered} buffered (cross-author dep)`
      : `${surface.appliedCount}/${total} applied`;
  }

  // Current wall-clock cutoff for the comment scrubber. At replay index 0
  // we use the session start time (no comments have "existed yet"); at any
  // forward index we use the wallClock of the most recently applied event.
  // Comments with createdAt <= cutoff are visible; later ones are hidden
  // until the scrub advances past their creation moment. v1 events without
  // wallClock fall through to the session startTime so the scrubber
  // degrades to "show all" instead of "hide all".
  private currentCommentCutoffMs(): number {
    if (!this.proof) return 0;
    const start = Date.parse(this.proof.session.startTime);
    if (!this.engine || this.engine.current === 0) return start;
    const idx = this.engine.current;
    const evt = this.proof.events[idx - 1];
    if (!evt) return start;
    return evt.wallClock ?? start;
  }

  // Push the comment bundle into a surface's read-only CommentStore and
  // dispatch the initial anchor previews onto the editor's decoration state.
  // Anchor positions are resolved against the surface's CURRENT Y.Doc — for
  // the merged surface that's the full reconstructed doc; for a track it's
  // the per-author CRDT slice (so anchors only resolve if the underlying
  // items exist on that track).
  private seedSurfaceComments(surface: Surface, bundle: CommentBundle | undefined): void {
    if (!surface.commentStore || !bundle) return;
    surface.commentStore.load(bundle);
    const cutoff = this.currentCommentCutoffMs();
    const previews = buildAnchorPreviews(
      surface.commentStore,
      (thumb) => this.authorIndex.get(thumb) ?? 0,
      cutoff,
    );
    surface.view.dispatch({ effects: setThreadAnchors.of(previews) });
  }

  // Refresh decoration state for every surface — call whenever the surface's
  // Y.Doc has changed (an event apply, a seek-reset, etc.) so anchors re-
  // resolve against the new doc state. Read-only and cheap. cutoffMsOverride
  // forces a specific scrubber position, used by dispatchEvent to pass the
  // just-applied event's wallClock without relying on engine.currentIndex
  // (which hasn't been incremented yet at that point).
  private refreshAllCommentDecorations(cutoffMsOverride?: number): void {
    if (this.mergedSurface) {
      this.refreshSurfaceComments(this.mergedSurface, cutoffMsOverride);
    }
    for (const t of this.trackSurfaces) this.refreshSurfaceComments(t, cutoffMsOverride);
  }

  private refreshSurfaceComments(surface: Surface, cutoffMsOverride?: number): void {
    if (!surface.commentStore) return;
    const cutoff = cutoffMsOverride ?? this.currentCommentCutoffMs();
    const previews = buildAnchorPreviews(
      surface.commentStore,
      (thumb) => this.authorIndex.get(thumb) ?? 0,
      cutoff,
    );
    surface.view.dispatch({ effects: setThreadAnchors.of(previews) });
  }

  // Apply a single event to a surface. v2 path = applyUpdateV2 (CRDT correct,
  // works for merged AND per-author surfaces). v1 path = position-based
  // dispatch onto the surface's editor view (correct for single-author or
  // merged unified replay; useful only as a fallback on track surfaces since
  // legacy positions are merged-doc-relative).
  private applyTo(surface: Surface, event: AuthoringEvent): void {
    if (event.yjsUpdate) {
      Y.applyUpdateV2(surface.ydoc, base64ToBytes(event.yjsUpdate));
    } else {
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

  // Hard-reset every surface back to an empty Y.Doc. We rebuild rather than
  // try to "undo" Yjs operations — Yjs updates can't be cleanly inverted, so
  // swapping in a fresh doc is the safest path. Called on seek-to-0 and at
  // the start of seekTo before replaying forward to the target index.
  private resetSurfaces(): void {
    const mergedContainer = this.mergedSurface?.container ?? this.mergedHost;
    const trackInfo = this.trackSurfaces.map((s) => ({
      container: s.container,
      thumb: s.authorThumbprint,
    }));

    this.tearDownSurfaces();

    this.mergedSurface = this.buildSurface(mergedContainer);
    this.seedSurfaceComments(this.mergedSurface, this.proof?.comments);
    if (this.mode === 'tracks') {
      for (const t of trackInfo) {
        const surface = this.buildSurface(t.container, t.thumb);
        this.trackSurfaces.push(surface);
        if (t.thumb) this.trackByAuthor.set(t.thumb, surface);
        if (this.proof?.comments && t.thumb) {
          const filtered = this.filterBundleForAuthor(this.proof.comments, t.thumb);
          this.seedSurfaceComments(surface, filtered);
        }
      }
    }
  }

  private tearDownSurfaces(): void {
    const teardown = (s: Surface | null) => {
      if (!s) return;
      try { s.view.dispatch({ effects: clearAuthorMarks.of(undefined) }); } catch { /* ok */ }
      s.view.destroy();
      s.ydoc.destroy();
    };
    teardown(this.mergedSurface);
    this.mergedSurface = null;
    for (const t of this.trackSurfaces) teardown(t);
    this.trackSurfaces = [];
    this.trackByAuthor.clear();
    // Tracks-host wraps each editor in a .replay-track row; clear those wrappers.
    this.tracksHost.innerHTML = '';
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
