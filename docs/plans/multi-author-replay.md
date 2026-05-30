# Multi-author replay correctness — implementation plan

## Goal

Make the **multi-author replay** byte-identical to what users actually saw in
the live editor. Today the per-author chains record CodeMirror absolute
positions (`from` / `to`), but those positions are valid only in the author's
**local** view of the Y.Doc at the moment of typing. When two authors edited
concurrently, the live doc is the result of Yjs's CRDT merge — and replaying
position-based events one-by-one produces a different state from the merge.

The fix has two phases:

- **Phase 1 (Option A)**: capture Yjs binary updates alongside (or instead of)
  CodeMirror position deltas, and replay through Yjs so the merge happens
  automatically and correctly.
- **Phase 2 (Option C)**: add a split-screen "per-author tracks" replay mode
  on top of Phase 1's correct data, so reviewers can see each contributor's
  work in isolation as well as the merged whole.

Phase 1 is non-negotiable for correctness. Phase 2 is UX polish.

The cryptographic proof's validity is unaffected by either phase — each
author's chain is signed and hash-linked already. This is purely about the
visible replay artifact.

---

## Background — why the current replay is wrong

```text
       User types in CodeMirror
              ↓
       CodeMirror Transaction (from/to/inserted — LOCAL view positions)
              ↓
       y-codemirror.next translates the change to a Y.Text operation
              ↓                                 ↓
       keystroke-plugin observes the tx     Y.Doc emits 'updateV2' with binary CRDT delta
              ↓                                 ↓
       captures { from, to, inserted }       (currently IGNORED)
              ↓
       session.handleEvent(raw)
              ↓
       EventStore appends → hash chain
```

The captured `from` / `to` are positions in the **merged** Y.Doc as visible to
this peer at the moment. When another peer is typing concurrently, their
captured positions reference *their* view, not ours. Yjs reconciles those into
a single canonical merged document at runtime — but the chain events don't
record that reconciliation.

When the replay engine then sorts events globally by timestamp and applies
each `{from, to, inserted}` to a single virgin document, it gets a state that
**didn't actually exist** during the live session.

This only breaks **multi-author** replay. Single-author replay is correct
because there's no merge — the author's view IS the canonical view.

---

# Phase 1 — Capture Yjs updates (Option A)

## Design

Capture each local Y.Doc `updateV2` (binary CRDT delta) and attach it to the
chain event. Replay applies the updates to a fresh `Y.Doc`; Yjs handles
merging, so the replayed state always matches the live state.

```text
       User types
              ↓
       CodeMirror tx — userEvent annotation captured (Prec.highest extension)
              ↓
       y-codemirror applies to Y.Text
              ↓
       Y.Doc updateV2 fires → handler reads userEvent + Yjs update bytes
              ↓
       session.handleEvent({ type, timestamp, yjsUpdate, inserted, deleted, from, to })
              ↓
       Chain event includes yjsUpdate (base64)
```

## Phase 1 tasks (bite-sized, sequential)

### Task 1.1 — Schema additions

**Files:** `src/types.ts`, `src/export/importer.ts`

- Add `yjsUpdate?: string` (base64-encoded `Uint8Array`) to `AuthoringEvent`.
- Add `yjsUpdate?: string` to `RawEvent` (the pre-hash type).
- Bump `ProofFile.version` literal from `1` to `1 | 2` (union — we still accept v1).
- Update importer's version guard to allow `1` or `2`.

**Acceptance:** TypeScript compiles. Existing v1 proofs still parse cleanly.

---

### Task 1.2 — Conditional hash payload

**File:** `src/crypto/hash-chain.ts`

- In `computeEventHash`, include `yjsUpdate` in the canonical-JSON payload
  **only if** the event has it set. Events without it hash exactly as before
  (preserving v1 chain validity).
- Same conditional in `validateChain` — it already uses `computeEventHash`,
  so no logic change there.

**Acceptance:** Existing v1 proof in Verify tab still reports "PROOF VALID".
A synthetic v2 event with a `yjsUpdate` field hashes deterministically
including that field.

---

### Task 1.3 — Capture Y.Doc updateV2 in main.ts

**Files:** `src/editor/keystroke-plugin.ts`, `src/main.ts`, `src/editor/setup.ts`

The order of operations matters. y-codemirror.next's updateListener fires
*before* the captureExtension by default, which means by the time the
captureExtension runs, the Y.Doc has already been mutated and `updateV2` has
already fired. We need to:

1. Use `Prec.highest` on a small extension that records the **userEvent
   annotation** of the most recent local CodeMirror transaction into a
   module-level variable. This runs *before* y-codemirror.
2. Subscribe to `ydoc.on('updateV2', (update, origin, doc, transaction) => …)`.
3. In the handler, skip remote updates (those from the YPartyKitProvider —
   identify by `origin === partyKitProvider` reference).
4. Read and consume the pending userEvent annotation.
5. Extract a best-effort `from / to / inserted / deleted / cursorAfter` from
   the transaction's `changedParentTypes` or by diffing y-text state before
   and after. (Used for paste detection and humanness profile — not for
   replay positioning.)
6. Encode the binary update as base64.
7. Hand the assembled RawEvent to `session.handleEvent`.

Delete the old `keystrokeCaptureExtension` callback path that constructed
events from `tr.changes.iterChanges`. Replace it with the userEvent-recording
extension only.

**Acceptance:** Open Editor, type a sentence. Inspect IndexedDB; each event
has a non-empty `yjsUpdate` field.

---

### Task 1.4 — Replay engine: apply Yjs updates

**Files:** `src/replay/replay-engine.ts`, `src/replay/replay-view.ts`

- Make `ReplayEngine` own a `Y.Doc` + `Y.Text` for the replay surface.
- The replay editor (`createEditor` in `replay-view.ts`) is already bound to
  a Y.Text via `yCollab(replayText, awareness)`. Reuse that. The engine
  applies updates to `replayDoc`; y-codemirror reflects them to the view
  automatically.
- `applyEvent(event)`:
  - If `event.yjsUpdate` is set → `Y.applyUpdateV2(this.replayDoc, base64Decode(event.yjsUpdate))`.
  - Otherwise (v1) → keep the legacy `view.dispatch({ changes: …, effects: … })` path.
- For author coloring on the Yjs path:
  - Before applying the update, set `this.currentReplayingAuthor =
    event.authorThumbprint`.
  - Subscribe `this.replayText.observe((event) => …)` once in the constructor.
    The delta tells us which absolute positions in the current replayed doc
    the new chars landed at. Dispatch `addAuthorMark` effects to the view
    for each insert range using the current author's palette index.
  - Clear `currentReplayingAuthor` after the apply returns.
- `resetView()`:
  - Wipe the replay Y.Text inside a transaction.
  - Dispatch `clearAuthorMarks`.
- `seekTo(index)` already iterates `applyEvent`, so it works for both paths
  with no change.

**Acceptance:** Import a v2 proof in Verify (which auto-loads Replay), hit
Play. The final reconstructed text equals `proof.finalDocument` byte-for-byte
(check via DOM `.cm-content` textContent length and substring spot-checks).
Author marks line up with which author typed each character.

---

### Task 1.5 — Document consistency check in verifier

**File:** `src/verification/verifier.ts`

- In `verifyDocumentConsistency`, branch on `proof.version`:
  - For v2: rebuild the doc by applying each event's `yjsUpdate` to a fresh
    `Y.Doc` in chronological order. Compare the resulting Y.Text string to
    `proof.finalDocument`. Pass / fail accordingly. This is now an *exact*
    check, not the legacy heuristic.
  - For v1: keep the current path (linear replay + last-checkpoint hash
    fallback).

**Acceptance:** A clean v2 multi-author proof reports
"Replayed document matches finalDocument" — the previous failure mode where
two-author proofs fell back to the hash-only check disappears.

---

### Task 1.6 — Session recovery from v2 events

**File:** `src/session/session-manager.ts`

`recover()` currently calls `setDocument(saved.document)` which writes the
stored text directly into the Y.Text. That destroys the CRDT history that
peers would expect on reconnect.

- When recovered events are v2 (have `yjsUpdate`): instead of `setDocument`,
  apply each event's update to the live Y.Doc via `Y.applyUpdateV2` in seq
  order, then resume. This rebuilds the CRDT history so reconnecting to
  PartyKit doesn't fight a divergent state.
- When events are v1: keep the current `setDocument` path for back-compat.
- Same change for `recoverFromCloud()`.

**Acceptance:** Open a v2 session, type 100 chars, kill the tab, reopen. The
text appears identically; the Live tier reconnects without conflict warnings;
typing continues to sign new v2 events.

---

### Task 1.7 — Stamp new sessions as v2

**File:** `src/session/session-manager.ts`

- Bump `APP_VERSION` from `'0.3.0'` to `'0.4.0'`.
- In `buildProofFile`, return `version: 2`.
- In `start()`, no schema change — but tag the session metadata so recovery
  knows to take the v2 path. (One option: read the `appVersion` and branch.)

**Acceptance:** A freshly-recorded session ends with `version: 2` in the
exported proof.

---

### Task 1.8 — Test plan (manual)

Run these scenarios in two browser contexts on the deployed URL:

1. **Single-author v2 proof correctness:**
   - alice records a paragraph, ends, exports. Verify shows PROOF VALID and
     "Replayed document matches finalDocument".
2. **Two-author concurrent edits, replay accuracy:**
   - alice and bob type into the same room at the same time. After ending,
     each exports a proof. Open alice's proof in Verify; the merged final
     document equals what was on screen during the live session.
3. **Mixed v1 + v2 import:**
   - Import an old v1 proof from before the change. Verify still works
     (legacy path).
4. **Recovery preserves Y.Doc state:**
   - Type 200 chars, kill tab, reopen. Continue typing. Export. The proof
     is intact and verifies.

---

# Phase 2 — Per-author tracks (Option C)

## Design

Once Phase 1 gives us correct merged replay, add a UI mode that shows each
author's work side-by-side. The merged page stays at the top; below it are
N collapsible "tracks", one per author, each a read-only mini-editor that
plays back only that author's chain into a separate Y.Doc.

## Phase 2 tasks

### Task 2.1 — Toggle in the Replay controls

**File:** `src/replay/replay-view.ts`

- Add a small "Tracks" toggle button next to the speed selector.
- When off (default), the current single merged view is shown.
- When on, the merged page becomes smaller (half height) and a "Per-author
  tracks" panel appears below it.

---

### Task 2.2 — Per-author mini-engines

**Files:** `src/replay/author-track.ts` (new), `src/replay/replay-view.ts`

- For each `authorThumbprint` in the proof's events, instantiate a
  `AuthorTrack { authorThumbprint, events, ydoc, yText, view }`.
- The author's events are the subset of `proof.events` where
  `authorThumbprint === track.authorThumbprint`, sorted by `seq`.
- Each track has its own Y.Doc + Y.Text + read-only CodeMirror view, bound
  via y-codemirror in read-only mode.
- The shared `ReplayEngine` drives all tracks: on each tick, if the current
  event belongs to author X, apply its yjsUpdate to X's track Y.Doc.

---

### Task 2.3 — Synchronised scrubbing across tracks

**File:** `src/replay/replay-engine.ts`

- When `seekTo(N)` is called:
  - Reset the main merged Y.Doc.
  - Reset every author's track Y.Doc.
  - Iterate events 0..N. For each event, apply its yjsUpdate to the merged
    Y.Doc *and* to its author's track Y.Doc.
- Author marks on the merged view stay as they are. Each track stays
  monochrome (it only shows one author).

---

### Task 2.4 — Visual polish

**File:** `src/ui/styles.css`

- Track container: vertical stack with thin dividers.
- Each track row: handle + colour swatch on the left (40px wide), mini
  editor on the right.
- Track mini-editors: max-height ~200px each, scroll internally if longer.
- Hide/show individual tracks (eye icon on the row).

---

# Files touched, total

Phase 1:
- `src/types.ts`
- `src/export/importer.ts`
- `src/crypto/hash-chain.ts`
- `src/editor/keystroke-plugin.ts`
- `src/editor/setup.ts`
- `src/main.ts`
- `src/replay/replay-engine.ts`
- `src/replay/replay-view.ts`
- `src/session/session-manager.ts`
- `src/verification/verifier.ts`

Phase 2:
- `src/replay/replay-view.ts` (toggle + layout)
- `src/replay/author-track.ts` (new)
- `src/ui/styles.css`

# Open questions worth pausing on

1. **Origin-distinguishing for `updateV2`**: we need a reliable way to tell
   "this update came from local typing" vs "this update came from peer sync
   via PartyKit." Using `origin === partyKitProvider` is the cleanest signal
   — confirm the YPartyKitProvider sets itself as the origin on remote
   applies. If not, attach a sentinel origin marker ourselves.

2. **Awareness updates** (cursor positions) don't fire `updateV2` because
   they're not part of the Y.Doc — they're separate. We do NOT want to sign
   them. Confirm this is true in current y-codemirror version.

3. **Format-bar buttons** dispatch CM transactions with synthetic userEvent
   `'input.format'`. The `Prec.highest` listener should still capture that
   annotation. Verify.

4. **Undo / redo** dispatch CM transactions which y-codemirror translates to
   inverse Y.Text ops. Those produce their own `updateV2`s and get signed as
   separate events. That's the correct behaviour — undos are part of the
   authorship trail.

5. **Mixed v1 + v2 in the same chain** is impossible if we bump `APP_VERSION`
   and recovery branches on it. A session is either all-v1 or all-v2.

6. **Storage size**: v2 events grow by ~50-150 bytes each from the base64
   Yjs update. A 50k-event session adds ~5-7 MB to the proof file. Well
   within Vercel Blob and IndexedDB tier limits.

# Effort estimate

- Phase 1 implementation: **6-8 hours focused**.
- Phase 2 implementation: **3-4 hours focused**.
- Cross-cutting testing + bug fixes: **2-3 hours**.
- Total: **~12-15 hours**.

# Acceptance criteria (overall)

After Phase 1:
- v2 multi-author proofs replay correctly — the final replayed document equals
  the live merged document.
- Verify tab reports "Replayed document matches finalDocument" for multi-author
  v2 proofs (currently it falls back to hash-only).
- All v1 proofs continue to verify identically (no regressions).
- Recovery from IDB + cloud preserves Y.Doc CRDT history for v2 sessions.

After Phase 2:
- A "Tracks" toggle in the Replay controls reveals per-author mini-editors.
- Scrubbing the timeline is synchronised across the merged view and every track.
- Each track plays back exactly that author's signed contributions in order.
