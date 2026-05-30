import * as Y from 'yjs';
import type { ProofFile, AuthoringEvent, PublicIdentitySnapshot, Comment } from '../types';
import {
  validateChain, sha256, canonicalJsonStringify, deriveChainGenesis,
} from '../crypto/hash-chain';
import { verifySignature } from '../crypto/signing';
import { base64ToBytes } from '../editor/yjs-bytes';
import { verifyComment } from '../comments/comment-signing';

// ─── Result types ──────────────────────────────────────────────────

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: string;
}

// Inter-keystroke gap buckets, in milliseconds. Buckets are half-open: a value
// v is in bucket i iff DELAY_BUCKETS[i].lo <= v < DELAY_BUCKETS[i].hi.
export const DELAY_BUCKETS: ReadonlyArray<{ lo: number; hi: number; label: string }> = [
  { lo: 0,    hi: 25,   label: '<25ms' },
  { lo: 25,   hi: 50,   label: '25–50' },
  { lo: 50,   hi: 100,  label: '50–100' },
  { lo: 100,  hi: 200,  label: '100–200' },
  { lo: 200,  hi: 500,  label: '200–500' },
  { lo: 500,  hi: 1000, label: '0.5–1s' },
  { lo: 1000, hi: 2000, label: '1–2s' },
  { lo: 2000, hi: Infinity, label: '>2s' },
];

// Boundaries for accumulating wall-clock writing time. A gap between two
// consecutive events in an author's chain is classified as:
//   * Active typing:  gap <= ACTIVE_GAP_MS
//   * Thinking pause: ACTIVE_GAP_MS < gap <= SESSION_BREAK_MS
//     (still counts toward active writing — the author is plausibly at the
//     keyboard, just reading or thinking)
//   * Session break:  gap > SESSION_BREAK_MS
//     (excluded from active writing; bumps the session counter; spans the
//     wall-clock gap between, e.g., closing the tab and reopening it later)
export const ACTIVE_GAP_MS = 60_000;
export const SESSION_BREAK_MS = 5 * 60_000;

export interface PasteSpike {
  timestamp: number;        // performance.now() time of paste (page-relative; mostly for legacy renderers)
  wallClock?: number;       // ms since epoch, when present on the event
  length: number;
  authorThumbprint: string;
}

// Per-author breakdown of activity. The merged view sums these.
export interface AuthorActivity {
  thumbprint: string;
  events: number;
  pastes: number;
  pastedChars: number;
  activeMs: number;         // sum of gaps within this author's chain that count as writing
  sessions: number;         // 1 + number of >SESSION_BREAK_MS gaps in this author's chain
  firstWallClock: number | null;
  lastWallClock: number | null;
}

export interface AuthoringActivity {
  totalEvents: number;
  typedEvents: number;       // input.type + delete.* + undo + redo
  pasteEvents: number;
  pastedChars: number;
  pasteSpikes: PasteSpike[];
  // Calendar span = max(wallClock) - min(wallClock) across all events.
  // null when no event carries wallClock (pre-0.4.0 proof).
  calendarSpanMs: number | null;
  // Total wall-clock time anyone was actively at the keyboard. Sum of per-
  // author gaps that fall inside the active-writing window. Multi-author
  // concurrent typing is counted PER AUTHOR (so person-minutes, not
  // wall-clock minutes). null when wallClock is unavailable.
  activeWritingMs: number | null;
  // Distinct work sessions = max number of session-break gaps across any one
  // author's chain, plus one. Captures e.g. "alice came back 3 times across
  // 4 days; bob came back once". null when wallClock is unavailable.
  sessions: number | null;
  medianGapMs: number;       // intra-page using `timestamp` field; works for v1 proofs too
  gapStdDevMs: number;
  delayHistogram: number[];  // count per DELAY_BUCKETS bucket (intra-page gaps)
  authors: AuthorActivity[];
}

// Per-comment verification result. Drives the Verify panel's Comments
// section + an aggregate pass/fail check in the overall result.
export interface CommentVerificationResult {
  comment: Comment;
  valid: boolean;
  reason?: string;     // present when valid === false
}

export interface CommentsVerificationSummary {
  total: number;
  passed: number;
  failed: number;
  // null when proof has no comments; the Verify UI hides the section then.
  details: CommentVerificationResult[] | null;
}

export interface VerificationResult {
  valid: boolean;
  checks: {
    genesisHash: CheckResult;
    hashChain: CheckResult;
    checkpointSignatures: CheckResult;
    documentConsistency: CheckResult;
    finalSignature: CheckResult;
    authoringActivity: AuthoringActivity;
    roster: CheckResult;
    comments: CommentsVerificationSummary;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function groupByAuthor(events: AuthoringEvent[]): Map<string, AuthoringEvent[]> {
  const map = new Map<string, AuthoringEvent[]>();
  for (const ev of events) {
    const arr = map.get(ev.authorThumbprint) ?? [];
    arr.push(ev);
    map.set(ev.authorThumbprint, arr);
  }
  // Each chain must be ordered by its own `seq`.
  for (const [, arr] of map) arr.sort((a, b) => a.seq - b.seq);
  return map;
}

function findAuthor(authors: PublicIdentitySnapshot[] | undefined, thumbprint: string): PublicIdentitySnapshot | undefined {
  return authors?.find((a) => a.thumbprint === thumbprint);
}

// ─── Verification ──────────────────────────────────────────────────

export async function verifyProof(proof: ProofFile): Promise<VerificationResult> {
  const genesisCheck = await verifyGenesisHash(proof);
  const chainCheck = await verifyHashChainsMultiAuthor(proof);
  const checkpointCheck = await verifyCheckpoints(proof);
  const docCheck = await verifyDocumentConsistency(proof);
  const finalSigCheck = await verifyFinalSignature(proof);
  const rosterCheck = verifyRoster(proof);
  const authoringActivity = analyzeAuthoringActivity(proof.events);
  const comments = await verifyComments(proof);

  const commentsPass = comments.total === 0 || comments.failed === 0;
  const valid =
    genesisCheck.passed &&
    chainCheck.passed &&
    checkpointCheck.passed &&
    docCheck.passed &&
    finalSigCheck.passed &&
    rosterCheck.passed &&
    commentsPass;

  return {
    valid,
    checks: {
      genesisHash: genesisCheck,
      hashChain: chainCheck,
      checkpointSignatures: checkpointCheck,
      documentConsistency: docCheck,
      finalSignature: finalSigCheck,
      authoringActivity,
      roster: rosterCheck,
      comments,
    },
  };
}

// Verify every comment's ECDSA signature against the author's pubkey in the
// roster. Comments whose author isn't in the roster fail with a clear reason
// (typed text says alice authored it, but no alice in roster → forged or
// roster incomplete). Each comment is its own authorship claim — no chain
// linkage between comments, so a single bad signature flags exactly that
// comment, not the whole batch.
async function verifyComments(proof: ProofFile): Promise<CommentsVerificationSummary> {
  const bundle = proof.comments;
  if (!bundle || bundle.comments.length === 0) {
    return { total: 0, passed: 0, failed: 0, details: null };
  }
  const roster = new Map<string, JsonWebKey>();
  for (const a of proof.session.authors ?? []) {
    roster.set(a.thumbprint, a.publicKey);
  }
  const details: CommentVerificationResult[] = [];
  for (const c of bundle.comments) {
    const pk = roster.get(c.authorThumbprint);
    if (!pk) {
      details.push({ comment: c, valid: false, reason: 'Author not in roster' });
      continue;
    }
    const ok = await verifyComment(c, pk);
    details.push({ comment: c, valid: ok, reason: ok ? undefined : 'Signature does not match' });
  }
  const failed = details.filter((d) => !d.valid).length;
  return { total: details.length, passed: details.length - failed, failed, details };
}

// ─── Genesis hash ──────────────────────────────────────────────────

async function verifyGenesisHash(proof: ProofFile): Promise<CheckResult> {
  // Local author's chain genesis is derived from (fileId, localAuthorThumbprint).
  const fileId = proof.session.fileId;
  const localThumb = proof.session.localAuthorThumbprint;
  if (!fileId || !localThumb) {
    return { passed: false, message: 'Proof missing fileId or localAuthorThumbprint' };
  }
  const computed = await deriveChainGenesis(fileId, localThumb);
  if (computed === proof.session.genesisHash) {
    return { passed: true, message: 'Genesis hash is valid' };
  }
  return {
    passed: false,
    message: 'Genesis hash mismatch',
    details: `Expected ${computed}, got ${proof.session.genesisHash}`,
  };
}

// ─── Hash-chain integrity, per-author ──────────────────────────────

async function verifyHashChainsMultiAuthor(proof: ProofFile): Promise<CheckResult> {
  if (proof.events.length === 0) {
    return { passed: true, message: 'No events to verify (empty session)' };
  }
  const fileId = proof.session.fileId;
  if (!fileId) {
    return { passed: false, message: 'Proof missing fileId — cannot derive per-author geneses' };
  }

  const byAuthor = groupByAuthor(proof.events);
  const errors: string[] = [];
  let totalEvents = 0;

  for (const [thumbprint, events] of byAuthor) {
    const genesis = await deriveChainGenesis(fileId, thumbprint);
    const result = await validateChain(events, genesis);
    if (!result.valid) {
      errors.push(`Author ${thumbprint.slice(0, 8)}…: ${result.errors.slice(0, 3).join(' | ')}`);
    }
    totalEvents += events.length;
  }

  if (errors.length === 0) {
    return {
      passed: true,
      message: `Hash chains intact (${byAuthor.size} author${byAuthor.size === 1 ? '' : 's'}, ${totalEvents} events total)`,
    };
  }
  return {
    passed: false,
    message: `Chain broken on ${errors.length} author chain(s)`,
    details: errors.join('\n'),
  };
}

// ─── Checkpoints ───────────────────────────────────────────────────

async function verifyCheckpoints(proof: ProofFile): Promise<CheckResult> {
  if (proof.checkpoints.length === 0) {
    return { passed: true, message: 'No checkpoints to verify' };
  }

  // For slice 1 only the local author signs checkpoints. Look up their public
  // key from the roster (or fall back to session.publicKey).
  const localThumb = proof.session.localAuthorThumbprint;
  const localAuthor = findAuthor(proof.session.authors, localThumb);
  const publicKey = localAuthor?.publicKey ?? proof.session.publicKey;
  if (!publicKey) {
    return { passed: false, message: 'No public key found for local author' };
  }

  // Build a map from seq → event for the local chain only (checkpoints reference seq).
  const localEvents = proof.events.filter((e) => e.authorThumbprint === localThumb);
  const bySeq = new Map<number, AuthoringEvent>();
  for (const e of localEvents) bySeq.set(e.seq, e);

  const errors: string[] = [];
  for (let i = 0; i < proof.checkpoints.length; i++) {
    const cp = proof.checkpoints[i];
    const event = bySeq.get(cp.atSeq);
    if (!event || event.hash !== cp.eventHash) {
      errors.push(`Checkpoint ${i}: eventHash doesn't match local-chain event at seq ${cp.atSeq}`);
      continue;
    }
    const payload = canonicalJsonStringify({
      atSeq: cp.atSeq,
      eventHash: cp.eventHash,
      documentHash: cp.documentHash,
      wallClock: cp.wallClock,
    });
    const valid = await verifySignature(publicKey, cp.signature, payload);
    if (!valid) errors.push(`Checkpoint ${i}: invalid signature`);
  }

  if (errors.length === 0) {
    return { passed: true, message: `All ${proof.checkpoints.length} checkpoint signatures valid` };
  }
  return {
    passed: false,
    message: `${errors.length} checkpoint(s) failed verification`,
    details: errors.join('\n'),
  };
}

// ─── Document consistency ─────────────────────────────────────────

async function verifyDocumentConsistency(proof: ProofFile): Promise<CheckResult> {
  // v2 proofs carry the binary Yjs update for every signed edit, so we can
  // replay the merged document EXACTLY by piping each update into a fresh
  // Y.Doc in chronological order. This is an exact check across any number
  // of concurrent authors — no more "two-author proofs fall back to hash".
  if (proof.version === 2) {
    if (proof.events.length === 0) {
      return proof.finalDocument === ''
        ? { passed: true, message: 'Empty session; finalDocument is empty' }
        : {
            passed: false,
            message: 'finalDocument is non-empty but no events were recorded',
          };
    }
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('main');
    for (const event of proof.events) {
      if (!event.yjsUpdate) {
        return {
          passed: false,
          message: 'Malformed v2 proof: event missing yjsUpdate',
          details: `Event seq ${event.seq} (author ${event.authorThumbprint.slice(0, 8)}…) has no yjsUpdate`,
        };
      }
      Y.applyUpdateV2(ydoc, base64ToBytes(event.yjsUpdate));
    }
    const reconstructed = ytext.toString();
    if (reconstructed === proof.finalDocument) {
      return { passed: true, message: 'Replayed document matches finalDocument' };
    }
    return {
      passed: false,
      message: 'Replayed document differs from finalDocument',
      details: `Replayed length ${reconstructed.length}, finalDocument length ${proof.finalDocument.length}`,
    };
  }

  // v1 path: events only carry CodeMirror positions. Linear replay is exact
  // for single-author proofs (no merge to reckon with). For multi-author v1
  // proofs there's no way to reconstruct the doc without the CRDT history,
  // so we fall back to checking the last checkpoint's documentHash.
  const byAuthor = groupByAuthor(proof.events);
  const isSingleAuthor = byAuthor.size <= 1;

  if (isSingleAuthor) {
    let doc = '';
    for (const event of proof.events) {
      if (event.inserted === '' && event.deleted === '') continue;
      doc = doc.slice(0, event.from) + event.inserted + doc.slice(event.from + event.deleted.length);
    }
    if (doc === proof.finalDocument) {
      return { passed: true, message: 'Replayed document matches finalDocument' };
    }
  }

  const docHash = await sha256(proof.finalDocument);
  const lastCp = proof.checkpoints[proof.checkpoints.length - 1];
  if (lastCp && lastCp.documentHash === docHash) {
    return {
      passed: true,
      message: 'finalDocument hash matches last checkpoint',
    };
  }
  if (isSingleAuthor) {
    return {
      passed: false,
      message: 'Document reconstruction mismatch',
      details: `Replayed length differs from finalDocument and last-checkpoint hash also differs.`,
    };
  }
  return {
    passed: false,
    message: 'Multi-author proof: cannot verify document — last checkpoint documentHash does not match finalDocument',
  };
}

// ─── Final signature ───────────────────────────────────────────────

async function verifyFinalSignature(proof: ProofFile): Promise<CheckResult> {
  const localEvents = proof.events.filter((e) => e.authorThumbprint === proof.session.localAuthorThumbprint);
  const sortedLocal = localEvents.sort((a, b) => a.seq - b.seq);
  const lastHash = sortedLocal.length > 0
    ? sortedLocal[sortedLocal.length - 1].hash
    : proof.session.genesisHash;

  const finalDocHash = await sha256(proof.finalDocument);

  const payload = canonicalJsonStringify({
    sessionId: proof.session.sessionId,
    genesisHash: proof.session.genesisHash,
    lastEventHash: lastHash,
    finalDocumentHash: finalDocHash,
    endTime: proof.session.endTime,
  });

  const localAuthor = findAuthor(proof.session.authors, proof.session.localAuthorThumbprint);
  const publicKey = localAuthor?.publicKey ?? proof.session.publicKey;
  const valid = await verifySignature(publicKey, proof.finalSignature, payload);
  if (valid) return { passed: true, message: 'Final session signature is valid' };
  return { passed: false, message: 'Final session signature is invalid' };
}

// ─── Roster integrity ─────────────────────────────────────────────

function verifyRoster(proof: ProofFile): CheckResult {
  const roster = proof.session.authors;
  if (!roster || roster.length === 0) {
    return { passed: false, message: 'Proof has no authors in the roster' };
  }
  const knownThumbs = new Set(roster.map((a) => a.thumbprint));
  const missing = new Set<string>();
  for (const ev of proof.events) {
    if (!knownThumbs.has(ev.authorThumbprint)) missing.add(ev.authorThumbprint);
  }
  if (missing.size > 0) {
    return {
      passed: false,
      message: `${missing.size} event author(s) missing from roster`,
      details: [...missing].slice(0, 5).map((t) => t.slice(0, 12)).join(', '),
    };
  }
  return {
    passed: true,
    message: `Roster has ${roster.length} author${roster.length === 1 ? '' : 's'}; every event attributable`,
  };
}

// ─── Authoring activity (pure statistics — no human-vs-AI verdict) ─

function bucketize(delayMs: number): number {
  for (let i = 0; i < DELAY_BUCKETS.length; i++) {
    if (delayMs >= DELAY_BUCKETS[i].lo && delayMs < DELAY_BUCKETS[i].hi) return i;
  }
  return DELAY_BUCKETS.length - 1;
}

export function analyzeAuthoringActivity(events: AuthoringEvent[]): AuthoringActivity {
  const empty: AuthoringActivity = {
    totalEvents: events.length,
    typedEvents: 0,
    pasteEvents: 0,
    pastedChars: 0,
    pasteSpikes: [],
    calendarSpanMs: null,
    activeWritingMs: null,
    sessions: null,
    medianGapMs: 0,
    gapStdDevMs: 0,
    delayHistogram: new Array(DELAY_BUCKETS.length).fill(0),
    authors: [],
  };
  if (events.length === 0) return empty;

  // Group + sort each chain by its own seq (the chain's canonical order).
  const byAuthor = new Map<string, AuthoringEvent[]>();
  for (const e of events) {
    const arr = byAuthor.get(e.authorThumbprint) ?? [];
    arr.push(e);
    byAuthor.set(e.authorThumbprint, arr);
  }
  for (const [, arr] of byAuthor) arr.sort((a, b) => a.seq - b.seq);

  // Intra-page gap stats from `timestamp` — these still work for v1 proofs
  // and for v2 proofs that pre-date wallClock. They underpin the median /
  // std-dev / histogram readouts the reviewer eyeballs.
  const intraPageGaps: number[] = [];
  const delayHistogram = new Array(DELAY_BUCKETS.length).fill(0);
  for (const [, arr] of byAuthor) {
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].timestamp - arr[i - 1].timestamp;
      if (d < 0) continue;          // performance.now() reset between events (different pages); skip
      if (d > SESSION_BREAK_MS) continue;  // cross-session gap — not a keystroke cadence
      intraPageGaps.push(d);
      delayHistogram[bucketize(d)] += 1;
    }
  }
  const sortedGaps = [...intraPageGaps].sort((a, b) => a - b);
  const medianGapMs = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
  const meanGap = intraPageGaps.length > 0
    ? intraPageGaps.reduce((s, d) => s + d, 0) / intraPageGaps.length : 0;
  const variance = intraPageGaps.length > 0
    ? intraPageGaps.reduce((s, d) => s + (d - meanGap) ** 2, 0) / intraPageGaps.length : 0;
  const gapStdDevMs = Math.sqrt(variance);

  // Per-author wall-clock breakdown.
  const authors: AuthorActivity[] = [];
  let allHaveWallClock = true;
  for (const [thumb, arr] of byAuthor) {
    const pastes = arr.filter((e) => e.type === 'input.paste' && e.inserted.length > 0);
    const pastedChars = pastes.reduce((s, e) => s + e.inserted.length, 0);

    let activeMs = 0;
    let sessions = 1;
    let firstWallClock: number | null = null;
    let lastWallClock: number | null = null;
    for (const e of arr) {
      if (typeof e.wallClock !== 'number') { allHaveWallClock = false; continue; }
      if (firstWallClock === null) firstWallClock = e.wallClock;
      lastWallClock = e.wallClock;
    }
    if (firstWallClock !== null) {
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1].wallClock;
        const b = arr[i].wallClock;
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        const gap = b - a;
        if (gap < 0) continue;
        if (gap > SESSION_BREAK_MS) { sessions += 1; continue; }
        activeMs += gap;
      }
    }
    authors.push({
      thumbprint: thumb,
      events: arr.length,
      pastes: pastes.length,
      pastedChars,
      activeMs: firstWallClock === null ? 0 : activeMs,
      sessions: firstWallClock === null ? 1 : sessions,
      firstWallClock,
      lastWallClock,
    });
  }

  // Merged totals across authors.
  const calendarFirst = authors.reduce<number | null>(
    (m, a) => a.firstWallClock !== null && (m === null || a.firstWallClock < m) ? a.firstWallClock : m,
    null,
  );
  const calendarLast = authors.reduce<number | null>(
    (m, a) => a.lastWallClock !== null && (m === null || a.lastWallClock > m) ? a.lastWallClock : m,
    null,
  );
  const calendarSpanMs = (calendarFirst !== null && calendarLast !== null)
    ? calendarLast - calendarFirst : null;

  const activeWritingMs = allHaveWallClock && authors.length > 0
    ? authors.reduce((s, a) => s + a.activeMs, 0) : null;
  const sessions = allHaveWallClock && authors.length > 0
    ? authors.reduce((m, a) => Math.max(m, a.sessions), 0) : null;

  const pasteSpikes: PasteSpike[] = events
    .filter((e) => e.type === 'input.paste' && e.inserted.length > 0)
    .map((e) => ({
      timestamp: e.timestamp,
      wallClock: e.wallClock,
      length: e.inserted.length,
      authorThumbprint: e.authorThumbprint,
    }))
    // Order by wallClock when available so paste timelines stay coherent
    // across page-reload boundaries; fall back to timestamp otherwise.
    .sort((a, b) => (a.wallClock ?? a.timestamp) - (b.wallClock ?? b.timestamp));

  return {
    totalEvents: events.length,
    typedEvents: events.filter((e) => e.type !== 'input.paste').length,
    pasteEvents: pasteSpikes.length,
    pastedChars: pasteSpikes.reduce((s, p) => s + p.length, 0),
    pasteSpikes,
    calendarSpanMs,
    activeWritingMs,
    sessions,
    medianGapMs: Math.round(medianGapMs),
    gapStdDevMs: Math.round(gapStdDevMs),
    delayHistogram,
    authors,
  };
}

// Format a millisecond duration as a short human-readable string. Renders
// "2d 3h 14m", "47m 12s", "12s", etc. Used by the Verify panel.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr - day * 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}
