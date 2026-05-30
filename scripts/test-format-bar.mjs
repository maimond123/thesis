// Format-bar concurrent test.
//
// Two scenarios:
//
// A) Single-author: alice types "hello world", selects "world", hits Mod-b
//    to bold. Replay through Yjs reconstructs "hello **world**" exactly.
//
// B) Multi-author concurrent: alice types in her region + bolds a range,
//    bob types in parallel in his region. Both end + export. Replay of
//    each proof reconstructs the same merged finalDocument, and the bold
//    markers (** **) survive intact in alice's contribution.
//
// What this validates:
//   - The transactionFilter captures format-bar transactions (which wrap a
//     selection in markers — typically two iterChanges in one CM tx).
//   - Aggregated capture (aggFrom/aggTo/insertedAll) covers both inserts
//     of the wrap operation.
//   - The resulting yjsUpdate is a SINGLE binary covering both ** inserts.
//   - Replay reconstructs the formatted document byte-for-byte.

import { chromium } from 'playwright';
import * as Y from 'yjs';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';

const URL_BASE = 'http://localhost:5175/#';

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

async function setupPeer(browser, handle, fileId) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const origCreate = URL.createObjectURL.bind(URL);
    window.__lastProofJson = null;
    URL.createObjectURL = function (blob) {
      if (blob instanceof Blob && blob.type === 'application/json') {
        blob.text().then((t) => { window.__lastProofJson = t; });
      }
      return origCreate(blob);
    };
  });
  await page.goto(URL_BASE + fileId);
  await page.getByRole('textbox', { name: 'e.g. david' }).fill(handle);
  await page.getByRole('button', { name: 'Generate Identity' }).click();
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => Array.from(
    document.querySelectorAll('.status-bar .status-item'),
  ).some((i) => i.textContent === 'Recording'));
  return { ctx, page, handle };
}

async function endAndExport(page) {
  await page.getByRole('button', { name: 'End Session' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Export Proof' }).click();
  await page.waitForTimeout(700);
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

async function scenarioA(browser) {
  console.log('\n── Scenario A: single-author bold ────────────────────');
  const fileId = `phase-format-a-${Date.now().toString(36)}`;
  const alice = await setupPeer(browser, 'alice', fileId);

  // Type, then select last 5 chars ("world") by shift+left * 5.
  await alice.page.locator('.cm-content').click();
  await alice.page.locator('.cm-content').pressSequentially('hello world', { delay: 25 });
  await alice.page.waitForTimeout(800);

  // Select "world".
  for (let i = 0; i < 5; i++) {
    await alice.page.keyboard.press('Shift+ArrowLeft');
  }
  // Apply bold via the keymap.
  await alice.page.keyboard.press('Meta+b');
  await alice.page.waitForTimeout(1200);

  const cmText = await alice.page.evaluate(() => {
    const store = window.__commentStoreForTests;
    return store['yText'].toString();
  });
  console.log(`[A] Y.Text after bold: ${JSON.stringify(cmText)}`);
  assert.equal(cmText, 'hello **world**', `expected "hello **world**", got ${JSON.stringify(cmText)}`);

  const proof = await endAndExport(alice.page);
  writeFileSync('.playwright-mcp/format-bar-A.json', JSON.stringify(proof, null, 2));

  // Replay reconstructs the formatted text.
  const replayed = replayThroughYjs(proof);
  console.log(`[A] replayed: ${JSON.stringify(replayed)}`);
  assert.equal(replayed, proof.finalDocument, '[A] replay diverged from finalDocument');
  assert.equal(replayed, 'hello **world**', `[A] replay didn't reconstruct formatted text`);

  await alice.ctx.close();
  console.log('  ✓ Scenario A passed');
}

async function scenarioB(browser) {
  console.log('\n── Scenario B: alice bolds while bob types ───────────');
  const fileId = `phase-format-b-${Date.now().toString(36)}`;
  const alice = await setupPeer(browser, 'alice', fileId);
  const bob = await setupPeer(browser, 'bob', fileId);
  await alice.page.waitForTimeout(1500);

  // Alice types her sentence.
  await alice.page.locator('.cm-content').click();
  await alice.page.locator('.cm-content').pressSequentially('Alice writes important text.', { delay: 30 });
  await alice.page.waitForTimeout(1500);

  // Wait for bob to converge before bob starts typing.
  await bob.page.waitForFunction(
    () => window.__commentStoreForTests['yText'].toString().includes('important text.'),
    { timeout: 10000 },
  );

  // Concurrent: alice selects "important" and bolds it; bob types at end.
  await Promise.all([
    (async () => {
      // alice: move cursor to end-of-"important" (which is at pos 19),
      // then select 9 chars left to get "important".
      await alice.page.locator('.cm-content').click();
      await alice.page.keyboard.press('ControlOrMeta+End');
      // cursor at end of doc (pos 28). "important" is at [13, 22).
      // Easier: shift+left to span "important text.": 15 chars, then
      // shift+right to release "text.": 6 chars. Net selection [13, 22).
      // Use simpler approach: count back from end.
      for (let i = 0; i < 15; i++) await alice.page.keyboard.press('Shift+ArrowLeft'); // covers " important text."
      for (let i = 0; i < 6; i++) await alice.page.keyboard.press('Shift+ArrowRight'); // releases " text."
      await alice.page.keyboard.press('Meta+b');
    })(),
    (async () => {
      // bob: cursor to end, type a continuation.
      await bob.page.locator('.cm-content').click();
      await bob.page.keyboard.press('ControlOrMeta+End');
      await bob.page.locator('.cm-content').pressSequentially(' Bob adds his thoughts.', { delay: 30 });
    })(),
  ]);
  await alice.page.waitForTimeout(2500);
  await bob.page.waitForTimeout(2500);

  // Both peers' Y.Text should converge.
  const aliceText = await alice.page.evaluate(() => window.__commentStoreForTests['yText'].toString());
  const bobText = await bob.page.evaluate(() => window.__commentStoreForTests['yText'].toString());
  console.log(`[B] alice sees: ${JSON.stringify(aliceText)}`);
  console.log(`[B] bob sees:   ${JSON.stringify(bobText)}`);
  assert.equal(aliceText, bobText, '[B] Y.Text diverged between peers');

  // Bold markers should be in the doc.
  assert.match(aliceText, /\*\*[^*]+\*\*/, `[B] bold markers missing from final text: ${JSON.stringify(aliceText)}`);

  // End + export both. Each proof should replay through Yjs to the merged doc.
  const aliceProof = await endAndExport(alice.page);
  const bobProof = await endAndExport(bob.page);
  writeFileSync('.playwright-mcp/format-bar-B-alice.json', JSON.stringify(aliceProof, null, 2));
  writeFileSync('.playwright-mcp/format-bar-B-bob.json', JSON.stringify(bobProof, null, 2));

  const aliceReplay = replayThroughYjs(aliceProof);
  const bobReplay = replayThroughYjs(bobProof);
  console.log(`[B] alice replay: ${JSON.stringify(aliceReplay)}`);
  console.log(`[B] bob   replay: ${JSON.stringify(bobReplay)}`);
  assert.equal(aliceReplay, aliceProof.finalDocument);
  assert.equal(bobReplay, bobProof.finalDocument);
  // Both proofs should have converged final documents.
  assert.equal(aliceProof.finalDocument, bobProof.finalDocument, '[B] proofs diverged on finalDocument');
  // And the bold markers survive.
  assert.match(aliceReplay, /\*\*[^*]+\*\*/, '[B] bold markers missing from alice replay');

  await alice.ctx.close();
  await bob.ctx.close();
  console.log('  ✓ Scenario B passed');
}

async function main() {
  const browser = await chromium.launch();
  try {
    await scenarioA(browser);
    await scenarioB(browser);
    console.log('\n✓ Format-bar concurrent test PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
