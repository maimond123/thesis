# Thesis

Proof of human authorship. A markdown editor that records every keystroke into a
signed, append-only hash chain, so a finished document ships with cryptographic
evidence of how it was written.

## Status

**Work in progress.** Last active May 2026. Built as a research prototype, not a
product. Single-author recording, export, verification, and replay all work. The
multi-author live session flow has known open blockers, written up in
[`docs/plans/multi-author-blockers.md`](./docs/plans/multi-author-blockers.md).

There is no release, no versioning policy, and no maintenance schedule. Issues and
pull requests may sit.

## The problem

A finished document carries no evidence of its own creation. A file written over
three weeks and a file pasted from a language model are byte-identical artifacts.
Any check applied after the fact (stylometry, classifier scoring, "AI detectors")
guesses at the process from the product, and guesses badly.

Thesis records the process instead. The evidence is generated while the author
types, signed as it accumulates, and verifiable by anyone who receives the file.

## How it works

Every editor transaction becomes an `AuthoringEvent`: a timestamp, the CodeMirror
change, the binary Yjs CRDT delta, and the author's thumbprint. Events append to a
per-author hash chain. Each link commits to the hash of the previous one, so
removing or reordering any event breaks every link after it.

At checkpoint granularity the chain head is signed with the author's ECDSA P-256
key. The key lives in IndexedDB and never leaves the browser; it is backed up as a
JSON file the author holds.

```
keystroke -> AuthoringEvent -> hash chain link -> (every N events) signed checkpoint
                    |
                    +-- yjsUpdate (binary CRDT delta, replays exact document state)
```

Exporting produces a `ProofFile`: the merged document, every author's event chain,
and their signed checkpoints. A verifier recomputes the chain from scratch, checks
the signatures against the embedded public keys, and replays the Yjs updates to
confirm the reconstructed document matches the one shipped in the file.

Timestamps use `performance.timeOrigin + performance.now()` rather than
`Date.now()`, so they stay comparable across page loads. Close the tab, reopen it
a day later, and the verifier can still tell how much wall-clock time passed
between the last event before the reload and the first one after it.

## Multi-author

The document is a Yjs CRDT synced over PartyKit, so several people can write in
one session. Each author keeps a separate chain signed with their own key. Nobody
can forge events attributed to somebody else, because a forged event fails the
signature check on that author's checkpoint.

Replay renders the merged timeline and per-author tracks, with a scrubber that
moves through the session in wall-clock time. Comment threads are signed and
chained the same way as keystrokes.

## Layout

| Path | What lives there |
|---|---|
| `src/crypto/` | Hash chain, canonical JSON, ECDSA signing, timestamps |
| `src/editor/` | CodeMirror setup, keystroke capture via `transactionFilter`, formatting |
| `src/session/` | Event store, IndexedDB persistence, cloud sync |
| `src/replay/` | Replay engine, per-author tracks, scrubber |
| `src/verification/` | Chain and signature verifier, verification UI |
| `src/comments/` | Signed review threads |
| `src/export/` | `ProofFile` reader and writer |
| `party/` | PartyKit servers: `yjs.ts` for document sync, `chain.ts` for chain broadcast |
| `api/sessions.ts` | Vercel Blob backed session snapshots |
| `scripts/` | Playwright end-to-end tests |
| `docs/plans/` | Design docs, including the open blockers |

## Running it

```bash
npm install
npm run dev
```

The end-to-end tests drive a real browser through Playwright:

```bash
node scripts/test-multi-author.mjs
node scripts/test-recovery.mjs
node scripts/test-replay-scrubbing.mjs
```

## What this does not prove

The chain proves that a sequence of edits happened in a browser holding a
particular key, in a particular order, with particular timing. It does not prove a
human produced them. An author who reads text from a second screen and retypes it
produces a clean chain. Treat it as evidence about process, not as a detector.

## Stack

Vite, TypeScript, CodeMirror 6, Yjs, y-codemirror.next, PartyKit, Vercel Blob,
Web Crypto (ECDSA P-256, SHA-256).
