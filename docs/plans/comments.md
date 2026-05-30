# Comments — implementation plan

## Goal

Let any author drop a comment on a range of text, get replies, mark threads
resolved — the Google-Docs / GitHub-PR experience. Comments propagate to
peers live (already a Y.Doc — sync is free), survive concurrent edits to
the doc (anchors don't drift), are cryptographically signed by their
author (so the proof file can prove "Alice said this at 2026‑05‑29 14:32"),
and ride along in the exported proof so a reviewer can read them in
Verify / Replay.

The proof of textual authorship (the hash chain on keystrokes) is unchanged.
Comments are a parallel, signed record of *review activity* on top of that
authorship.

---

## Background — concept framework

Tier 1 concepts in play here, in order of weight:

1. **State, mutation, and time.** Comment anchors are positions in a doc
   that's actively being edited. A naive `{from, to}` pair drifts the
   moment someone types upstream of it. Yjs's `Y.RelativePosition` is the
   right abstraction — it pins to a *logical* point in the CRDT graph,
   not to an absolute index, so the anchor moves with the surrounding
   text automatically. This is the same problem we solved for replay
   correctness in Phase 1 (replay needed CRDT-correct state), seen again
   in a new clothing.

2. **Data structures and access patterns.** We need two access patterns:
   "give me every thread with its replies, in time order" (side panel)
   and "give me threads whose anchor range overlaps cursor position X"
   (in-line highlight on hover, inline indicator). Storing threads and
   comments in two `Y.Map`s keyed by ID gives O(1) lookup; an in-memory
   index keyed by anchor resolves the position lookup on demand. Don't
   store anchor *positions* — store the relative positions and resolve
   them at read time.

3. **Abstraction and indirection.** "Thread" is the user-visible unit
   (one anchor, one resolution state, N comments). "Comment" is the
   smaller unit (one author, one body, one signature). Two interfaces,
   one composition relationship. Don't conflate them — even though a
   single-comment thread looks identical to its root comment, treating
   them as the same type makes "add a reply" awkward.

4. **Composition.** A thread is a root comment + 0..N replies. Resolution
   is a property of the thread, not of any individual comment. Signing
   is per-comment (each one is its own authorship claim).

Tier 2 concepts surfaced:

- **Types and contracts (#5).** The signed payload's canonical-JSON shape
  is the contract between signer and verifier. Pin it explicitly; never
  let it drift.
- **Concurrency (#7).** Two peers may comment on the same range at the
  same time; both threads should appear. No locking — the Y.Map's
  CRDT semantics handle it.

---

## Design

### Storage

The live Y.Doc gets two new top-level types:

```ts
ydoc.getMap('comment-threads')  // Y.Map<threadId, Y.Map<ThreadFields>>
ydoc.getMap('comments')         // Y.Map<commentId, Y.Map<CommentFields>>
```

Two `Y.Map`s rather than one nested structure because Yjs nesting can get
awkward with reactivity — peers observing one shape sometimes miss inner
mutations. Flat maps with foreign-key references are easier to reason
about and easier to migrate later.

### Anchoring (the state-and-time problem)

```ts
// Stored on the thread:
anchorStart: string  // base64-encoded Y.encodeRelativePosition output
anchorEnd:   string
```

`Y.createRelativePositionFromTypeIndex(yText, pos)` produces a
`RelativePosition` pointing to a CRDT *item*, not an index. To resolve
back to an absolute position at render time:
`Y.createAbsolutePositionFromRelativePosition(rel, ydoc)`. If the
underlying text item was deleted, the resolution may return `null`
or fall back to a tombstone — surface this as "comment on deleted text"
rather than crashing.

### Types

```ts
interface CommentThread {
  id: string;                  // UUID
  rootCommentId: string;
  anchorStart: string;         // base64(Y.encodeRelativePosition)
  anchorEnd: string;
  resolved: boolean;
  resolvedAt?: string;         // ISO wall-clock
  resolvedBy?: string;         // author thumbprint
  createdAt: string;           // ISO wall-clock
}

interface Comment {
  id: string;                  // UUID
  threadId: string;
  parentId: string | null;     // null for root; else other comment.id
  authorThumbprint: string;
  authorHandle: string;        // cached for offline render
  body: string;
  createdAt: string;           // ISO wall-clock
  signature: string;           // ECDSA-P256 over canonicalJson(payload)
}
```

Signed payload (canonical JSON shape, same `canonicalJsonStringify`
used by the chain hash):

```ts
{
  authorThumbprint, threadId, parentId, body, createdAt
}
```

`id` is NOT signed — it's a client-generated UUID. `authorHandle` is
display metadata, not authoritative (the thumbprint is what verifies).

### Proof file

Add to `ProofFile`:

```ts
comments?: {
  threads: CommentThread[];
  comments: Comment[];
}
```

Optional so v2 proofs without comments still parse. The verifier's
chain integrity check is untouched; a new `verifyComments` check
walks each comment, looks up the author's public key in the roster,
and verifies the signature.

### UI

**Editor tab:**

- On non-empty text selection, a small floating "Comment" pill appears
  near the selection (same pattern as the format bar). Click → compose
  modal beside the selection: textarea + Submit.
- Each thread's anchor range gets a subtle yellow underline + small
  margin indicator (right gutter) showing the thread's author handle.
- Click the gutter indicator (or the underlined range) → opens the
  thread side panel.
- Side panel docked right: shows the active thread (anchor preview text,
  root comment, replies, reply box, resolve button) and a vertical list
  of all other open threads in the doc.
- Resolved threads collapsed by default; toggle to show them.

**Replay tab:**

Comments visible as read-only annotations. Unified mode: gutter indicators
at each thread's anchor; clicking opens the thread. Tracks mode: same on
the merged surface; per-author tracks show only that author's authored
comments.

**Verify tab:**

A new "Comments" section after "Authoring activity" listing each thread
+ replies with author + signature pass/fail.

### Sync

The Y.Maps live in the same Y.Doc as `getText('main')`, so y-partykit's
provider already syncs them. No new channel needed. Awareness can be
extended later for "X is commenting now" presence.

### Persistence

The session-manager's `saveSession` snapshots `getDocument()` (text only)
today. Extend that to also snapshot the comments shape, IDB + cloud both.
Recovery reads it back into the Y.Maps via `Y.applyUpdate` or direct
Map.set.

---

## Tasks (bite-sized, sequential)

### Task C.1 — Schema + types

**Files:** `src/types.ts`, `src/comments/types.ts` (new)

- Add `CommentThread` and `Comment` interfaces.
- Add `ProofFile.comments?: { threads: CommentThread[]; comments: Comment[] }`.
- Bump `ProofFile.version` to `1 | 2 | 3`? — **No.** Keep v2; comments
  are additive. Verifier degrades cleanly when missing.

**Acceptance:** `tsc --noEmit` clean.

---

### Task C.2 — CommentStore (Y.Doc-backed)

**File:** `src/comments/comment-store.ts` (new)

A thin wrapper over the two Y.Maps:

```ts
class CommentStore {
  constructor(ydoc: Y.Doc, yText: Y.Text, identity: IdentityStore) {}
  async createThread(range: { from: number; to: number }, body: string): Promise<CommentThread>
  async reply(threadId: string, body: string): Promise<Comment>
  resolveThread(threadId: string): void
  unresolveThread(threadId: string): void
  listThreads(): CommentThread[]
  listComments(threadId: string): Comment[]
  resolveAnchor(thread: CommentThread): { from: number; to: number } | null
  onChange(cb: () => void): () => void          // for UI to re-render
}
```

Constructor takes the Y.Doc + the Y.Text it's commenting on (to compute
RelativePositions) + the IdentityStore (to sign). createThread:

1. Build the canonical-JSON payload from the comment fields.
2. Sign with the local identity.
3. Insert thread + root comment atomically inside a `ydoc.transact`.

`resolveAnchor` returns `null` when both endpoints map to tombstones —
caller renders "(anchored text deleted)".

**Acceptance:** Unit-test-style script that creates a thread, replies,
resolves, and reads them back via a fresh CommentStore on the same Y.Doc.

---

### Task C.3 — Sign + verify comment payloads

**Files:** `src/comments/comment-signing.ts` (new), reuse
`src/crypto/signing.ts`.

- `signComment(c: ...) → string` — wraps canonicalJsonStringify + ECDSA.
- `verifyComment(c: Comment, publicKey: JsonWebKey) → Promise<boolean>`.
- Both pure functions; no Y.Doc dependency.

**Acceptance:** Round-trip test: sign → verify pass; tamper one byte
of body → verify fail.

---

### Task C.4 — Floating "Comment" pill + compose modal

**Files:** `src/comments/compose-ui.ts` (new), `src/main.ts`.

- CM update listener watches `view.state.selection`. When a non-empty
  selection lands and stays for 200ms, position a floating "Comment"
  button just above the selection's end coordinates (use
  `view.coordsAtPos`).
- Click → modal anchored to the same coords: textarea + Submit + Cancel.
- Submit: `commentStore.createThread({from, to}, body)`. Modal closes,
  pill disappears, gutter indicator appears.

Style: feels like the format bar; doesn't intercept keystrokes while open.

**Acceptance:** Select text in Editor → pill appears. Click → modal
opens. Type + submit → IDB shows new thread + comment with valid
signature.

---

### Task C.5 — Thread side panel

**Files:** `src/comments/side-panel.ts` (new), `src/main.ts`,
`src/ui/styles.css`.

- Right-docked side panel, ~360px wide, toggleable via a "Comments"
  button next to "Import Proof".
- Lists all open threads vertically: anchor preview text (first 40 chars
  of the anchored range), root author + handle, body, N replies, time.
- Clicking a thread expands it inline: replies list + reply textarea +
  resolve button.
- Resolved threads collapsed under a separator at the bottom.

**Acceptance:** Open the panel, see the thread from C.4, reply,
resolve. Re-open the file → the same state.

---

### Task C.6 — Inline highlight + gutter indicator

**Files:** `src/comments/decorations.ts` (new), wire into the editor
extensions in `src/main.ts`.

- A CM StateField holds the comment decorations.
- For each open thread, decorate the anchored range with a subtle yellow
  underline.
- A gutter on the right with one indicator per thread (small dot in the
  author's palette color). Hover → tooltip with anchor preview + author.
- Click a gutter dot or an underlined range → opens the thread in the
  side panel.

**Acceptance:** Threads show underline + gutter dots. Edit text upstream
of an anchor — the underline moves with the text (Y.RelativePosition
doing its job).

---

### Task C.7 — Replay tab integration

**File:** `src/replay/replay-view.ts`.

- During replay, comments are read-only annotations. Decorate the merged
  surface the same way the Editor does.
- Tracks mode: the same decorations on the merged surface; per-author
  tracks show only that author's authored comments (filter by
  `comment.authorThumbprint`).

Comments are NOT replayed event-by-event — they appear all at once at
the start of replay since they're metadata, not part of the keystroke
chain. Time scrubbing doesn't change which threads are visible (a
v2-of-comments feature could timeline them; out of scope here).

**Acceptance:** Import a v2 proof with comments → Replay tab shows the
threads as read-only annotations.

---

### Task C.8 — Verify tab section

**File:** `src/verification/verifier.ts`, `src/verification/verify-ui.ts`.

- New `verifyComments(proof)` check: for each comment, look up the
  author's public key in `proof.session.authors`, verify the signature.
  Aggregate result: "All N comments verified" or "M of N failed".
- New panel below Authoring activity: list each thread + replies with
  per-comment signature pass/fail and a tiny resolved/open badge.

**Acceptance:** Multi-author proof with multi-author comments verifies
cleanly. Tamper one comment body in the JSON → that comment shows fail
while everything else stays valid.

---

### Task C.9 — Persistence + recovery + proof export

**Files:** `src/session/session-manager.ts`, `src/session/persistence.ts`,
`src/session/cloud-sync.ts`, `src/export/exporter.ts`,
`src/export/importer.ts`.

- `saveSession` and `cloudSave` snapshot the comment threads + comments
  as plain arrays alongside `document`.
- `recover` and `recoverFromCloud` rehydrate the Y.Maps from the
  snapshot before re-enabling capture.
- `buildProofFile` reads from the live Y.Maps and includes them under
  `proof.comments`.
- Importer accepts proofs with or without `comments`.

**Acceptance:** Type some text + add 2 threads with 1 reply each →
End → Export. Import the proof in a fresh tab → all 4 comments
intact, all signatures verify.

---

### Task C.10 — Manual test plan

1. **Single-author single-thread:** create thread, see in Editor + side
   panel, end + export, verify shows "1 comment verified", replay shows
   the thread inline.
2. **Multi-author reply:** alice creates thread, bob replies, alice
   resolves. Both peers' proofs carry all three comments. Both verify.
3. **Anchor follows edits:** create thread, then add text 20 chars
   upstream of the anchor. Confirm the underline moves with the text.
4. **Deleted anchor:** create thread, then delete the anchored range.
   Confirm the side panel marks it "(anchored text deleted)" but the
   thread still verifies (signature is on body, not anchor).
5. **Tamper detection:** edit one byte of a comment body in the exported
   JSON. Verify flags exactly that comment.

---

## Files touched, total

New:
- `src/comments/types.ts`
- `src/comments/comment-store.ts`
- `src/comments/comment-signing.ts`
- `src/comments/compose-ui.ts`
- `src/comments/side-panel.ts`
- `src/comments/decorations.ts`

Modified:
- `src/types.ts`
- `src/main.ts`
- `src/session/session-manager.ts`
- `src/session/persistence.ts`
- `src/session/cloud-sync.ts`
- `src/export/exporter.ts`
- `src/export/importer.ts`
- `src/replay/replay-view.ts`
- `src/verification/verifier.ts`
- `src/verification/verify-ui.ts`
- `src/ui/styles.css`

---

## Open questions worth pausing on

1. **Should comments enter the keystroke chain?** No (this plan): each
   comment is signed standalone. Reason: comments are review activity,
   not authorship of the document. Tying them into the chain would mean
   recovery / replay treats them as authoring events, which they aren't.
   They get their own per-comment signature so authorship is still
   provable.

2. **Concurrent reply numbering / ordering?** Both peers may reply to
   the same thread at the same time. We display in `createdAt` order;
   ties broken by `id`. No "edit comment" feature in v1 — too much
   complexity (would need a per-comment chain like the keystroke chain).

3. **"Edit comment" feature.** Punt. v1 is create + delete (or just
   create — even delete may be punt-able).

4. **Awareness for "X is typing a comment".** Punt. Existing awareness
   already shows X's cursor; that's enough for v1.

5. **Comments on Replay vs Verify vs Editor.** Show everywhere, edit
   only in Editor.

---

## Effort estimate

- Tasks C.1 → C.3 (schema, store, signing): **2-3h**
- Tasks C.4 → C.6 (editor UI: pill, panel, decorations): **3-5h**
- Tasks C.7 → C.8 (replay + verify integration): **2-3h**
- Task C.9 (persistence + export): **1-2h**
- Task C.10 (manual testing + bug fixing): **2-3h**
- Total: **10-16h focused**

---

## Acceptance criteria (overall)

- Editor: select text → pill → compose → thread visible.
- Side panel: lists threads, replies, resolve toggle, anchored preview.
- Anchors follow doc edits (CRDT-correct).
- Multi-author: comments sync via y-partykit; both peers see the same
  threads + replies.
- Proof: comments included; verifier reports per-comment signature
  pass/fail.
- Replay: comments visible as read-only annotations on the merged
  surface and on per-author tracks (filtered by author).
- Recovery: kill the tab with comments in progress; reopen — all
  comments restored.
- No regressions: every Phase 1 + Phase 2 + activity-stats test still
  passes.
