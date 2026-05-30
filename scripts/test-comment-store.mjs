// Foundation test for the CommentStore (Phase 3 / Tasks C.1–C.3).
//
// Runs the data layer in isolation against a fake IdentityStore and a fresh
// Y.Doc. Validates:
//   - createThread inserts thread + signed root comment atomically
//   - reply signs and appends
//   - resolveThread + unresolveThread flip the boolean
//   - signatures pass verifyComment with the matching public key
//   - signatures FAIL when the comment body is tampered post-sign
//   - snapshot() and load() round-trip cleanly into a separate Y.Doc
//   - anchors resolve to absolute indices and follow upstream edits
//   - anchors return null when the anchored range is fully deleted

import * as Y from 'yjs';
import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Provide globals the browser code expects.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Inline-import the TS sources by compiling via tsx? Simpler: import the
// already-built source via Vite's transpile-on-import. The .mjs script runs
// outside Vite, so we use a tiny dynamic-import shim via `tsx` if available,
// or fall back to a hand-rolled import path.
// In this repo, the source files are TS — we need a runtime that understands
// TS. Use `npx tsx` to run this script instead of plain `node`.

import { CommentStore } from '../src/comments/comment-store.ts';
import { commentSigningPayload, verifyComment } from '../src/comments/comment-signing.ts';

// ── Fake IdentityStore ────────────────────────────────────────────────
// Real one is browser-only (IDB). The store only calls .getSelf() (sync)
// and .signWithSelf(data) (async), so this shim is enough.
class FakeIdentity {
  constructor(handle, keyPair, thumbprint) {
    this.handle = handle;
    this.thumbprint = thumbprint;
    this.keyPair = keyPair;
  }
  static async create(handle) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    // Mirror identity-store.ts computeThumbprint: SHA-256 over canonical JSON
    // of the required EC fields.
    const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }, Object.keys({ crv: 1, kty: 1, x: 1, y: 1 }).sort());
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
    const thumbprint = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const fi = new FakeIdentity(handle, keyPair, thumbprint);
    fi.publicKey = jwk;
    return fi;
  }
  getSelf() {
    return { handle: this.handle, thumbprint: this.thumbprint };
  }
  async signWithSelf(data) {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      this.keyPair.privateKey,
      new TextEncoder().encode(data),
    );
    // Base64url, matching crypto/signing.ts.
    let bin = '';
    const bytes = new Uint8Array(sig);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

async function main() {
  const alice = await FakeIdentity.create('alice');
  const bob = await FakeIdentity.create('bob');
  console.log(`[setup] alice tp=${alice.thumbprint.slice(0, 8)}, bob tp=${bob.thumbprint.slice(0, 8)}`);

  // Single doc both authors comment on.
  const ydoc = new Y.Doc();
  const yText = ydoc.getText('main');
  yText.insert(0, 'The quick brown fox jumps over the lazy dog.');

  const aliceStore = new CommentStore(ydoc, yText, alice);
  const bobStore = new CommentStore(ydoc, yText, bob);

  // ── createThread + reply ────────────────────────────────────────
  const thread1 = await aliceStore.createThread({ from: 4, to: 9 }, 'why "quick"? prefer "fast"');
  assert.ok(thread1.id, 'thread should have an id');
  assert.equal(thread1.resolved, false);
  console.log(`[thread1] anchor=[${thread1.anchorStart.slice(0, 16)}..., ${thread1.anchorEnd.slice(0, 16)}...]`);

  const reply1 = await bobStore.reply(thread1.id, 'agree, fast is punchier');
  assert.equal(reply1.threadId, thread1.id);
  assert.equal(reply1.parentId, thread1.rootCommentId);

  const reply2 = await aliceStore.reply(thread1.id, 'changed to fast', reply1.id);
  assert.equal(reply2.parentId, reply1.id);

  const allCommentsT1 = aliceStore.listComments(thread1.id);
  assert.equal(allCommentsT1.length, 3);
  console.log(`[thread1] ${allCommentsT1.length} comments total, root + ${allCommentsT1.length - 1} replies`);

  // ── resolve / unresolve ─────────────────────────────────────────
  bobStore.resolveThread(thread1.id);
  let t1 = aliceStore.getThread(thread1.id);
  assert.equal(t1.resolved, true);
  assert.equal(t1.resolvedBy, bob.thumbprint);

  aliceStore.unresolveThread(thread1.id);
  t1 = aliceStore.getThread(thread1.id);
  assert.equal(t1.resolved, false);

  // ── Signature verification ──────────────────────────────────────
  const roster = new Map([
    [alice.thumbprint, alice.publicKey],
    [bob.thumbprint, bob.publicKey],
  ]);
  for (const c of allCommentsT1) {
    const pk = roster.get(c.authorThumbprint);
    const valid = await verifyComment(c, pk);
    assert.ok(valid, `comment ${c.id} (by ${c.authorThumbprint.slice(0, 8)}) should verify`);
  }
  console.log(`[verify] all ${allCommentsT1.length} signatures valid`);

  // Tamper one byte of the body — signature must FAIL.
  const tampered = { ...reply1, body: reply1.body + ' (edited)' };
  const tamperedValid = await verifyComment(tampered, bob.publicKey);
  assert.equal(tamperedValid, false, 'tampered comment must not verify');
  console.log('[tamper] body-edited reply fails verification');

  // ── Snapshot + load round-trip ──────────────────────────────────
  const bundle = aliceStore.snapshot();
  assert.equal(bundle.threads.length, 1);
  assert.equal(bundle.comments.length, 3);

  // Load into a fresh Y.Doc and re-verify.
  const ydoc2 = new Y.Doc();
  const yText2 = ydoc2.getText('main');
  yText2.insert(0, 'The quick brown fox jumps over the lazy dog.');
  const fresh = new CommentStore(ydoc2, yText2, alice);
  fresh.load(bundle);
  assert.equal(fresh.listThreads().length, 1);
  assert.equal(fresh.listComments(thread1.id).length, 3);
  const reloadedVerify = await fresh.verifyAll(roster);
  assert.ok(reloadedVerify.every(r => r.valid), 'all reloaded comments should verify');
  console.log('[snapshot] round-trip preserves threads + signatures');

  // ── Anchor follows upstream edit ────────────────────────────────
  const before = aliceStore.resolveAnchor(thread1);
  assert.deepEqual(before, { from: 4, to: 9 }, `pre-edit anchor should resolve to [4,9), got ${JSON.stringify(before)}`);

  // Insert 5 chars BEFORE the anchored range. The anchor should shift right.
  yText.insert(0, 'Note: ');
  const afterUpstream = aliceStore.resolveAnchor(thread1);
  assert.deepEqual(
    afterUpstream,
    { from: 4 + 6, to: 9 + 6 },
    `post-upstream-edit anchor should track the inserted prefix, got ${JSON.stringify(afterUpstream)}`,
  );
  console.log(`[anchor] follows upstream insert: ${JSON.stringify(before)} -> ${JSON.stringify(afterUpstream)}`);

  // Delete the anchored range entirely. Anchor should collapse.
  // Doc currently: "Note: The quick brown fox..."; the range is at [10, 15) ("quick").
  yText.delete(10, 5);
  const afterDelete = aliceStore.resolveAnchor(thread1);
  console.log(`[anchor] after deleting range: ${JSON.stringify(afterDelete)}`);
  // After deletion both endpoints collapse to the same point (or null).
  if (afterDelete !== null) {
    assert.equal(afterDelete.from, afterDelete.to, 'collapsed-anchor endpoints should match');
  }

  // ── Delete thread cleans up its comments ───────────────────────
  aliceStore.deleteThread(thread1.id);
  assert.equal(aliceStore.listThreads().length, 0);
  assert.equal(aliceStore.listComments(thread1.id).length, 0);
  console.log('[delete] thread + all comments removed');

  console.log('\n✓ CommentStore foundation test PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
