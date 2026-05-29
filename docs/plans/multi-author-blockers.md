# Multi-author live-session blockers — fix plan

## Goal

Make the live three-person flow actually usable for collaborative writing on
one shared document. The current `main` build has two blockers that prevent
real co-authoring:

1. **Joining a session wipes the shared document.**
2. **Late joiners never receive the existing per-author chain history**, so
   their exported `ProofFile` is incomplete (it has the merged Yjs document
   but is missing the signed event chains from peers who started recording
   before they joined).

After this work, three friends should be able to open the app on three
machines, each click "Start Session" at any moment, and each end up with
a valid `ProofFile` containing the full attributed history.

## Context for someone with zero codebase knowledge

- **Stack:** Vite + TypeScript SPA. CodeMirror 6 editor. Yjs for the shared
  document state. y-codemirror.next binds Yjs ↔ editor. PartyKit hosts the
  Yjs sync (`party/yjs.ts`, "main" party) and a separate JSON-broadcast
  channel (`party/chain.ts`, "chain" party) for signed per-author event
  chunks. Vercel Blob backs `/api/sessions` for versioned cloud snapshots.
- **Data model:** every keystroke becomes an `AuthoringEvent` carrying
  `authorThumbprint`. Each author has their own append-only hash chain,
  signed at checkpoint granularity by that author's persistent ECDSA P-256
  identity (stored in IndexedDB; backed up as a JSON file).
- **Recent commits** (`git log` on `main`):
    - `b5230da` Per-author colored replay with legend
    - `cb27332` Multi-author proof of authorship: identities, Yjs sync, durability
- **What works today:** solo recording with all six Verify checks green;
  live Yjs doc sync between peers; chain-message broadcast (live, not
  replayed); per-author colored replay; versioned cloud backup.
- **What doesn't:** the two blockers below.

## Blocker 1 — Start Session wipes the shared doc

### Symptom
Whoever clicks **Start Session** second erases everyone else's work,
because the click handler dispatches a Yjs delete that propagates to
all peers.

### Root cause
In `src/main.ts`, the `startBtn.addEventListener('click', …)` handler
runs this before `session.start()`:

```ts
ydoc.transact(() => {
  if (yText.length > 0) yText.delete(0, yText.length);
});
```

### Fix
Remove the wipe entirely. `session.start()` should begin LOCAL recording
on whatever document state currently exists (which will be whatever has
synced in via Yjs from peers). A user who actually wants a fresh blank
doc can select-all + delete in the editor before starting.

### Files
- `src/main.ts` — `startBtn` click handler

### Acceptance
After change: with the editor containing "hello world", clicking Start
Session leaves the text intact, resets `Events: 0`, and flips the status
dot to recording.

---

## Blocker 2 — Late joiners receive no chain history

### Symptom
Alice types 200 signed events. Bob opens the URL. Bob's mirror chain for
Alice is empty. Bob's exported `ProofFile` is missing Alice's 200 events
entirely — only Bob's own contributions appear.

### Root cause
`party/chain.ts` is stateless: `onMessage` calls `room.broadcast()` to
live connections only. There's no persistence and no replay-on-connect.

### Fix
Persist every chain message in PartyKit room storage on receive. In
`onConnect`, list all stored messages and `conn.send()` them in
insertion order to the newly connected peer. The existing client-side
`onChainMessage` → `session.appendRemoteEvent(...)` path will absorb
them transparently — replayed messages look identical to live ones.

### Files
- `party/chain.ts`

### Acceptance
- Alice connects, sends 5 chain messages, disconnects.
- Bob connects fresh → server replays the 5 messages to Bob via
  the chain WebSocket.
- Bob's exported `ProofFile` includes all 5 of Alice's events plus
  Alice in the roster, and all six Verify checks pass.

---

## Implementation steps

### Step 1 — Strip the wipe out of `Start Session`

**File:** `src/main.ts`

Locate this block in the `startBtn` click handler:

```ts
startBtn.addEventListener('click', async () => {
  if (!editorView) return;

  // Clear the shared doc via Yjs (NOT a direct CM dispatch — Y.Text is the
  // source of truth, and clearing through Yjs cleanly propagates to all peers).
  ydoc.transact(() => {
    if (yText.length > 0) yText.delete(0, yText.length);
  });

  await session.start(() => yText.toString());
  …
});
```

Replace with:

```ts
startBtn.addEventListener('click', async () => {
  if (!editorView) return;

  // Begin recording on the current document state — do NOT wipe. The
  // Yjs Y.Text may already contain content synced from peers in the
  // room; the local author's chain just starts capturing new keystrokes
  // from this point onward.
  await session.start(() => yText.toString());
  …
});
```

(Delete the comment block and the `ydoc.transact` block; keep the rest
of the handler unchanged.)

**Manual verification:** Run `npm run dev`. Type "hello" into the editor.
Click Start Session. Confirm: text still says "hello"; status bar shows
"Recording   Events: 0".

**Commit message suggestion:**
`Fix Start Session wiping the shared Yjs doc (B1)`

---

### Step 2 — Persist + replay chain messages in `party/chain.ts`

**File:** `party/chain.ts`

Replace the entire current file with:

```ts
import type * as Party from 'partykit/server';

// Chain party — verbatim JSON broadcast for per-author signed event
// chunks. This server intentionally does NOT verify signatures: each
// peer verifies on receive (see Blocker 3 in the brainstorm — that
// verification arrives in a later commit). The server's only jobs:
//   1. Broadcast incoming messages live to other peers in the room.
//   2. Persist every message and replay the full history to any peer
//      that connects later, so a late joiner ends up with the same
//      mirror chains as everyone else.

const MSG_PREFIX = 'msg:';

export default class ChainRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection) {
    const stored = await this.room.storage.list({ prefix: MSG_PREFIX });
    // Map iteration is insertion-ordered, and our keys are timestamp-
    // prefixed, so this replays in chronological order.
    for (const [, value] of stored) {
      try { conn.send(value as string); }
      catch { /* connection may close mid-replay; fine */ }
    }
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== 'string') return;
    // Timestamp-prefixed key (padded so lexical sort = chronological)
    // plus a random suffix so two messages in the same ms don't collide.
    const ts = Date.now().toString().padStart(16, '0');
    const key = `${MSG_PREFIX}${ts}:${crypto.randomUUID()}`;
    await this.room.storage.put(key, message);
    this.room.broadcast(message, [sender.id]);
  }
}

ChainRoom satisfies Party.Worker;
```

**Manual verification (single browser, two contexts):**

1. Restart PartyKit: `kill` any running `workerd`, then `npx partykit dev`.
2. Open the app in Tab A (normal window). Set handle "alice". Backup
   identity (private) and download Share Public Identity.
3. Click Start Session. Type "first message ".
4. Open the app in Tab B (incognito / private). Set handle "bob".
   Import alice's public bundle.
5. Tab B should see "first message " via Yjs sync (this already worked).
6. Tab B clicks Start Session — text remains (B1). Bob types "and second.".
7. Tab A: End Session, Export Proof.
8. Tab B: End Session, Export Proof.
9. Open each proof in the Verify tab. Both proofs should report:
    - Roster has 2 authors; every event attributable
    - Hash chains intact (2 authors, N events total)
    - All checkpoint signatures valid
    - PROOF VALID

(Note: Verify tab still uses the Replay code path that draws colored
events — both authors should appear in the legend.)

**Commit message suggestion:**
`Persist and replay chain history on connect (B2)`

---

## Test plan summary (overall acceptance)

- Two browser tabs (incognito for the second) can both Start Session
  on the same shared room without erasing each other.
- A tab that opens after another tab has been recording for a while
  receives the existing chain history via replay and ends up with a
  complete mirror chain.
- Both tabs' exported `ProofFile`s pass all six Verify checks (genesis,
  per-author chains, checkpoint signatures, document consistency,
  final signature, roster) and contain BOTH authors.

## Out of scope (deferred to a future plan)

- Blocker 3 from the discussion (cryptographic verification of incoming
  chain events — mirror chain trust hardening). Defer until after the
  3-person session works for trusted collaborators.
- Multi-file `Project` model (current `fileId` is hardcoded to `'default'`).
- Roster mutation via invite link instead of JSON exchange.
- E2E encryption of chain messages.
- On-chain anchor at the project level.

## Estimated effort

- Step 1: ~10 minutes incl. dev-server verification.
- Step 2: ~45 minutes incl. two-tab manual test.
- Total: under an hour of focused work.
