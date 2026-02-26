import type { AuthoringEvent } from '../types';
import { EditorView } from '@codemirror/view';
import type { ChangeSpec } from '@codemirror/state';

export type ReplayState = 'stopped' | 'playing' | 'paused';

const MAX_DELAY_MS = 3000;

export class ReplayEngine {
  private events: AuthoringEvent[];
  private currentIndex = 0;
  private _state: ReplayState = 'stopped';
  private timeoutId: number | null = null;
  private _speed = 1;
  private view: EditorView | null = null;

  onProgress?: (index: number, total: number) => void;
  onStateChange?: (state: ReplayState) => void;

  constructor(events: AuthoringEvent[]) {
    this.events = events;
  }

  attachView(view: EditorView): void {
    this.view = view;
  }

  get state(): ReplayState {
    return this._state;
  }

  get speed(): number {
    return this._speed;
  }

  get total(): number {
    return this.events.length;
  }

  get current(): number {
    return this.currentIndex;
  }

  play(): void {
    if (!this.view || this.events.length === 0) return;
    this._state = 'playing';
    this.onStateChange?.('playing');
    this.scheduleNext();
  }

  pause(): void {
    this._state = 'paused';
    this.onStateChange?.('paused');
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  stop(): void {
    this._state = 'stopped';
    this.onStateChange?.('stopped');
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.currentIndex = 0;
    this.resetView();
  }

  setSpeed(speed: number): void {
    this._speed = speed;
  }

  seekTo(index: number): void {
    const wasPlaying = this._state === 'playing';
    this.pause();

    this.resetView();
    this.currentIndex = 0;

    // Apply all events up to index without delay
    const target = Math.min(index, this.events.length);
    for (let i = 0; i < target; i++) {
      this.applyEvent(this.events[i]);
      this.currentIndex = i + 1;
    }

    this.onProgress?.(this.currentIndex, this.events.length);

    if (wasPlaying && this.currentIndex < this.events.length) {
      this.play();
    }
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

    const rawDelay = event.timestamp - prevTimestamp;
    const delay = Math.min(rawDelay, MAX_DELAY_MS) / this._speed;

    this.timeoutId = window.setTimeout(() => {
      this.applyEvent(event);
      this.currentIndex++;
      this.onProgress?.(this.currentIndex, this.events.length);
      this.scheduleNext();
    }, delay);
  }

  private applyEvent(event: AuthoringEvent): void {
    if (!this.view) return;

    const changes: ChangeSpec[] = [];
    if (event.inserted !== '' || event.deleted !== '') {
      changes.push({
        from: event.from,
        to: event.from + event.deleted.length,
        insert: event.inserted,
      });
    }

    if (changes.length > 0) {
      this.view.dispatch({
        changes,
        selection: { anchor: event.cursorAfter },
      });
    }
  }

  private resetView(): void {
    if (!this.view) return;
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: '',
      },
    });
  }
}
