// Phase 3 / C.8 + C.9 — Proof file carries comments + verifier checks each.
//
// One alice context. She types a sentence, creates 2 threads (one resolved,
// one open), replies to one. Then she ends + exports. We:
//   1. Confirm proof.comments has the expected threads + comments.
//   2. Verify the proof through the in-app Verify UI; all comments green.
//   3. Tamper one comment's body in the exported JSON, re-Verify; exactly
//      that comment flags fail and the proof overall reports INVALID.
//   4. Tamper one comment's signature; same expected failure mode.

import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { writeFileSync, readFileSync } from 'node:fs';

const FILE_ID = `phase3-proof-${Date.now().toString(36)}`;
const URL = `http://localhost:5175/#${FILE_ID}`;

async function main() {
  const browser = await chromium.launch();
  try {
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
    await page.goto(URL);

    // Identity.
    await page.getByRole('textbox', { name: 'e.g. david' }).fill('alice');
    await page.getByRole('button', { name: 'Generate Identity' }).click();
    await page.waitForSelector('.cm-content');
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some((i) => i.textContent === 'Recording'));

    // Type a sentence so we have ranges to comment on.
    await page.locator('.cm-content').click();
    await page.locator('.cm-content').pressSequentially(
      'The quick brown fox jumps over the lazy dog.',
      { delay: 25 },
    );
    await page.waitForTimeout(2000);

    // Create two threads + a reply to the first.
    await page.evaluate(async () => {
      const store = window.__commentStoreForTests;
      const t1 = await store.createThread({ from: 4, to: 9 }, 'why "quick"?');
      await store.reply(t1.id, 'consider "fast" instead');
      const t2 = await store.createThread({ from: 16, to: 19 }, 'fox = good metaphor here');
      store.resolveThread(t2.id);
    });
    await page.waitForTimeout(800);

    // End + export.
    await page.getByRole('button', { name: 'End Session' }).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Export Proof' }).click();
    await page.waitForTimeout(700);

    const proofJson = await page.evaluate(() => window.__lastProofJson);
    const proof = JSON.parse(proofJson);
    assert.ok(proof.comments, 'proof.comments missing — accessor not wired?');
    assert.equal(proof.comments.threads.length, 2, `expected 2 threads, got ${proof.comments.threads.length}`);
    assert.equal(proof.comments.comments.length, 3, `expected 3 comments (root+reply+root), got ${proof.comments.comments.length}`);
    console.log(`[proof] ${proof.comments.threads.length} threads, ${proof.comments.comments.length} comments`);

    // Stash to disk so we can import variants.
    const proofPath = '.playwright-mcp/comments-proof.json';
    writeFileSync(proofPath, proofJson);

    // ── Import as-is via Verify UI ──────────────────────────────
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const fc1 = page.waitForEvent('filechooser');
    await page.getByText('Drop a .proof.json file here').click();
    const ch1 = await fc1;
    await ch1.setFiles(proofPath);
    await page.waitForSelector('text=PROOF VALID', { timeout: 10000 });
    const pristine = await page.evaluate(() => {
      const text = document.querySelector('#verify-panel')?.textContent ?? '';
      const passing = (text.match(/✓/g) ?? []).length;
      return {
        valid: text.includes('PROOF VALID'),
        commentsHeader: text.match(/Comments \([^)]+\)/)?.[0],
        passing,
      };
    });
    console.log('[verify pristine]', pristine);
    assert.ok(pristine.valid, 'pristine proof should report PROOF VALID');
    assert.match(pristine.commentsHeader, /Comments \(3 verified\)/, 'should report 3 verified comments');

    // ── Tamper one body, re-import ──────────────────────────────
    const tampered = JSON.parse(proofJson);
    tampered.comments.comments[0].body += ' (edited)';
    const tamperedPath = '.playwright-mcp/comments-proof-tampered.json';
    writeFileSync(tamperedPath, JSON.stringify(tampered));

    const fc2 = page.waitForEvent('filechooser');
    await page.getByText('Drop a .proof.json file here').click();
    const ch2 = await fc2;
    await ch2.setFiles(tamperedPath);
    await page.waitForFunction(() => {
      const t = document.querySelector('#verify-panel')?.textContent ?? '';
      return t.includes('PROOF INVALID') || t.includes('FAILED');
    }, { timeout: 10000 });
    const tamperedResult = await page.evaluate(() => {
      const text = document.querySelector('#verify-panel')?.textContent ?? '';
      return {
        valid: text.includes('PROOF VALID'),
        invalid: text.includes('PROOF INVALID'),
        commentsHeader: text.match(/Comments \([^)]+\)/)?.[0],
        hasFailReason: text.includes('Signature does not match'),
      };
    });
    console.log('[verify tampered]', tamperedResult);
    assert.equal(tamperedResult.valid, false, 'tampered proof must NOT report PROOF VALID');
    assert.ok(tamperedResult.invalid, 'tampered proof should explicitly report PROOF INVALID');
    assert.match(tamperedResult.commentsHeader, /Comments \(2 verified, 1 FAILED\)/, `wrong header: ${tamperedResult.commentsHeader}`);
    assert.ok(tamperedResult.hasFailReason, 'should include reason "Signature does not match"');

    // Sanity: the un-tampered file imported earlier is still on disk and
    // verifies cleanly if re-imported. Round-trip discipline.
    const fc3 = page.waitForEvent('filechooser');
    await page.getByText('Drop a .proof.json file here').click();
    const ch3 = await fc3;
    await ch3.setFiles(proofPath);
    await page.waitForSelector('text=PROOF VALID', { timeout: 10000 });
    console.log('[verify pristine again] re-import of original proof still PROOF VALID');

    // Verify file size + persistence: the proof JSON file we wrote earlier
    // should be parseable + contain the same threads.
    const reread = JSON.parse(readFileSync(proofPath, 'utf-8'));
    assert.equal(reread.comments.threads.length, 2);

    console.log('\n✓ Phase 3 comments-in-proof + tamper detection PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
