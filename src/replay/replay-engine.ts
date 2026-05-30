import type { AuthoringEvent } from '../types';

export type ReplayState = 'stopped' | 'playing' | 'paused';

const MAX_DELAY_MS = 3000;

// ReplayEngine drives the timeline and emits "apply this event now" to a
// dispatcher provided by the view. It does NOT touch CodeMirror or Yjs
// directly — that lives in ReplayView, which knows whether to apply the
// event via Yjs (unified mode) or to a per-author editor (tracks mode).
export class ReplayEngine {
  private events: AuthoringEvent[];
  private currentIndex = 0;
  private _state: ReplayState = 'stopped';
  private timeoutId: number | null = null;
  private _speed = 1;
  private dispatchEvent: (event: AuthoringEvent) => void;
  private resetView: () => void;

  // Exposed for the editor's CodeMirror updateListener: it reads this while
  // a Yjs update is in mid-apply so it can colour the newly-inserted range
  // with the right author.
  currentAuthorThumbprint: string | null = null;

  onProgress?: (index: number, total: number) => void;
  onStateChange?: (state: ReplayState) => void;

  constructor(
    events: AuthoringEvent[],
    dispatchEvent: (event: AuthoringEvent) => void,
    resetView: () => void,
  ) {
    this.events = events;
    this.dispatchEvent = dispatchEvent;
    this.resetView = resetView;
  }

  get state(): ReplayState { return this._state; }
  get speed(): number { return this._speed; }
  get total(): number { return this.events.length; }
  get current(): number { return this.currentIndex; }

  setSpeed(speed: number): void { this._speed = speed; }

  play(): void {
    if (this.events.length === 0) return;
    this._state = 'playing';
    this.onStateChange?.('playing');
    this.scheduleNext();
  }

  pause(): void {
    this._state = 'paused';
    this.onStateChange?.('paused');
    if (this.timeoutId !== null) { clearTimeout(this.timeoutId); this.timeoutId = null; }
  }

  stop(): void {
    this._state = 'stopped';
    this.onStateChange?.('stopped');
    if (this.timeoutId !== null) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    this.currentIndex = 0;
    this.resetView();
  }

  seekTo(index: number): void {
    const wasPlaying = this._state === 'playing';
    this.pause();
    // Hard reset to the start, then replay forward. This is the safe path
    // when the replay surface holds a Y.Doc, because Yjs updates can't be
    // cleanly "undone" — rebuilding from scratch is the simplest correct way.
    this.resetView();
    this.currentIndex = 0;
    const target = Math.min(Math.max(0, index), this.events.length);
    for (let i = 0; i < target; i++) {
      this.dispatchEvent(this.events[i]);
      this.currentIndex = i + 1;
    }
    this.onProgress?.(this.currentIndex, this.events.length);
    if (wasPlaying && this.currentIndex < this.events.length) this.play();
  }

  apply(event: AuthoringEvent): void {
    this.dispatchEvent(event);
  }

  private scheduleNext(): void {
    if (this.currentIndex >= this.events.length || this._state !== 'playing') {
      this._state = 'stopped';
      this.onStateChange?.('stopped');
      return;
    }
    const event = this.events[this.currentIndex];
    const prevTimestamp = this.currentIndex > 0
      ? this.events[this.currentIndex - 1].timestamp
      : event.timestamp;
    const rawDelay = Math.max(0, event.timestamp - prevTimestamp);
    const delay = Math.min(rawDelay, MAX_DELAY_MS) / this._speed;
    this.timeoutId = window.setTimeout(() => {
      this.dispatchEvent(event);
      this.currentIndex++;
      this.onProgress?.(this.currentIndex, this.events.length);
      this.scheduleNext();
    }, delay);
  }
}
