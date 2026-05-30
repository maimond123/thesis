// Phase 1 multi-author replay correctness test.
//
// Launches two isolated browser contexts (alice + bob), connects them to the
// same partykit room, interleaves keystrokes, ends both sessions, exports
// each peer's proof, then asserts:
//   1. Both peers' final Y.Text is identical (CRDT convergence)
//   2. Each peer's proof carries events from both authors
//   3. Replaying each proof through a fresh Y.Doc produces finalDocument
//   4. The full Verify pipeline reports PROOF VALID with the v2 doc check

import { chromium } from 'playwright';
import * as Y from 'yjs';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';

const FILE_ID = `phase1-multi-${Date.now().toString(36)}`;
const URL = `http://localhost:5175/#${FILE_ID}`;

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

async function setupPeer(browser, handle) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Hook URL.createObjectURL so the eventual export hands us the JSON.
  await page.addInitScript(() => {
    const origCreate = URL.createObjectURL.bind(URL);
    window.__lastProofJson = null;
    URL.createObjectURL = function(blob) {
      if (blob instanceof Blob && blob.type === 'application/json') {
        blob.text().then(t => { window.__lastProofJson = t; });
      }
      return origCreate(blob);
    };
  });

  await page.goto(URL);
  // First-run modal
  await page.getByRole('textbox', { name: 'e.g. david' }).fill(handle);
  await page.getByRole('button', { name: 'Generate Identity' }).click();
  // Wait for editor + auto-start session
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => {
    const items = document.querySelectorAll('.status-bar .status-item');
    return Array.from(items).some(i => i.textContent === 'Recording');
  });
  return { ctx, page };
}

async function type(page, text, perChar = 50) {
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').pressSequentially(text, { delay: perChar });
}

async function endAndExport(page) {
  await page.getByRole('button', { name: 'End Session' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Export Proof' }).click();
  await page.waitForTimeout(500);
  const json = await page.evaluate(() => window.__lastProofJson);
  return JSON.parse(json);
}

function replayThroughYjs(proof) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('main');
  for (const ev of proof.events) {
    if (!ev.yjsUpdate) throw new Error(`event seq ${ev.seq} missing yjsUpdate`);
    Y.applyUpdateV2(ydoc, b64ToBytes(ev.yjsUpdate));
  }
  return ytext.toString();
}

function authorsByThumb(proof) {
  return new Map(proof.events.map(e => [e.authorThumbprint, true]));
}

async function main() {
  const browser = await chromium.launch();
  try {
    const alice = await setupPeer(browser, 'alice');
    const bob = await setupPeer(browser, 'bob');

    // Give the chain channel + yjs provider time to establish.
    await alice.page.waitForTimeout(1500);
    await bob.page.waitForTimeout(1500);

    // Interleaved concurrent typing. Both peers type into the same room
    // simultaneously; the chunks alternate so Yjs has to actually merge.
    const aliceChunks = ['Alice: ', 'I think the proof is sound. ', 'But check the merge. '];
    const bobChunks = ['Bob: ', 'Agreed, but lets test edges. ', 'Especially deletes. '];

    for (let i = 0; i < aliceChunks.length; i++) {
      await Promise.all([
        type(alice.page, aliceChunks[i], 30),
        type(bob.page, bobChunks[i], 30),
      ]);
      await alice.page.waitForTimeout(300);
    }

    // Settle, then read both Y.Texts.
    await alice.page.waitForTimeout(2500);
    await bob.page.waitForTimeout(2500);

    // .cm-content textContent includes y-codemirror's remote-cursor name
    // widget, which renders at the OTHER peer's cursor — so the two peers'
    // textContent differ even when the underlying Y.Text is identical. The
    // authoritative CRDT-convergence check is below on proof.finalDocument
    // (which calls Y.Text.toString() — no widgets included).
    const aliceText = await alice.page.evaluate(() => document.querySelector('.cm-content')?.textContent);
    const bobText = await bob.page.evaluate(() => document.querySelector('.cm-content')?.textContent);
    console.log(`[textContent] alice sees: ${JSON.stringify(aliceText)}`);
    console.log(`[textContent] bob   sees: ${JSON.stringify(bobText)}`);

    // End and export from both peers.
    const aliceProof = await endAndExport(alice.page);
    const bobProof = await endAndExport(bob.page);

    console.log(`[finalDocument] alice: ${JSON.stringify(aliceProof.finalDocument)}`);
    console.log(`[finalDocument] bob:   ${JSON.stringify(bobProof.finalDocument)}`);

    // True CRDT convergence: both peers' Y.Text serialisation should match.
    assert.equal(
      aliceProof.finalDocument,
      bobProof.finalDocument,
      'Y.Text diverged between peers after merge',
    );

    writeFileSync(
      '.playwright-mcp/multi-author-alice.json',
      JSON.stringify(aliceProof, null, 2),
    );
    writeFileSync(
      '.playwright-mcp/multi-author-bob.json',
      JSON.stringify(bobProof, null, 2),
    );

    // Each proof must be v2 stamped.
    assert.equal(aliceProof.version, 2, 'alice proof not v2');
    assert.equal(bobProof.version, 2, 'bob proof not v2');

    // Both proofs must carry events from BOTH authors.
    const aliceAuthors = authorsByThumb(aliceProof);
    const bobAuthors = authorsByThumb(bobProof);
    console.log(`[chain] alice proof authors: ${aliceAuthors.size}, events: ${aliceProof.events.length}`);
    console.log(`[chain] bob   proof authors: ${bobAuthors.size}, events: ${bobProof.events.length}`);
    assert.equal(aliceAuthors.size, 2, 'alice proof missing co-author chain');
    assert.equal(bobAuthors.size, 2, 'bob proof missing co-author chain');

    // Every event in every proof must carry yjsUpdate (v2 invariant).
    for (const ev of aliceProof.events) {
      assert.ok(typeof ev.yjsUpdate === 'string', `alice event seq ${ev.seq} missing yjsUpdate`);
    }
    for (const ev of bobProof.events) {
      assert.ok(typeof ev.yjsUpdate === 'string', `bob event seq ${ev.seq} missing yjsUpdate`);
    }

    // Apply each proof's events through a fresh Y.Doc; result must equal
    // finalDocument byte-for-byte (the verifier's v2 doc-consistency rule).
    const aliceReplayed = replayThroughYjs(aliceProof);
    const bobReplayed = replayThroughYjs(bobProof);
    console.log(`[replay] alice: ${JSON.stringify(aliceReplayed.slice(0, 80))}...`);
    console.log(`[replay] bob:   ${JSON.stringify(bobReplayed.slice(0, 80))}...`);

    assert.equal(aliceReplayed, aliceProof.finalDocument, 'alice replay diverged from finalDocument');
    assert.equal(bobReplayed, bobProof.finalDocument, 'bob replay diverged from finalDocument');

    // Drive the in-app Verify UI for alice's proof to confirm the full
    // pipeline (genesis, hashes, checkpoints, doc consistency, final sig,
    // roster) all pass against a v2 multi-author proof.
    await alice.page.getByRole('button', { name: 'Verify' }).click();
    await alice.page.getByText('Drop a .proof.json file here').click({ trial: false }).catch(() => {});
    const fileChooserPromise = alice.page.waitForEvent('filechooser');
    await alice.page.getByText('Drop a .proof.json file here').click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles('.playwright-mcp/multi-author-alice.json');
    await alice.page.waitForSelector('text=PROOF VALID', { timeout: 10000 });
    const verifySummary = await alice.page.evaluate(() => {
      const text = document.querySelector('#verify-panel')?.textContent ?? '';
      return {
        valid: text.includes('PROOF VALID'),
        chains: text.match(/Hash chains intact \([^)]*\)/)?.[0],
        doc: text.match(/Replayed document matches finalDocument|finalDocument hash matches last checkpoint|cannot verify/)?.[0],
        sig: text.match(/Final session signature is valid|invalid/)?.[0],
        roster: text.match(/Roster has [^;]+;[^.]+/)?.[0],
      };
    });
    console.log('[verify] alice proof =>', verifySummary);
    assert.ok(verifySummary.valid, 'alice proof did not report PROOF VALID');
    assert.match(verifySummary.chains, /2 authors/, 'chain check missing 2 authors');
    assert.equal(verifySummary.doc, 'Replayed document matches finalDocument', 'doc-consistency v2 failed');
    assert.equal(verifySummary.sig, 'Final session signature is valid', 'final sig invalid');

    console.log('\n✓ Multi-author replay correctness test PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
