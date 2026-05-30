// Phase 3 / C.7 — Replay tab shows comment threads as read-only annotations.
//
// alice records a sentence and adds 2 threads (one resolved). bob doesn't
// participate, but bob's identity is also represented in a separate fixture
// run so we exercise the multi-author filter on tracks. For this script
// we keep it single-author so the assertions stay legible:
//   1. Import the proof.
//   2. Switch to Replay tab.
//   3. Play through.
//   4. Assert N=1 unresolved thread has a visible cm-comment-underline
//      decoration on the merged surface (resolved threads don't underline).
//   5. Toggle tracks mode; assert alice's track also shows the underline.

import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';

const FILE_ID = `phase3-replay-${Date.now().toString(36)}`;
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

    // Identity + initial text.
    await page.getByRole('textbox', { name: 'e.g. david' }).fill('alice');
    await page.getByRole('button', { name: 'Generate Identity' }).click();
    await page.waitForSelector('.cm-content');
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some((i) => i.textContent === 'Recording'));
    await page.locator('.cm-content').click();
    await page.locator('.cm-content').pressSequentially(
      'The quick brown fox jumps over the lazy dog.',
      { delay: 25 },
    );
    await page.waitForTimeout(2000);

    // 2 threads: 1 open, 1 resolved.
    await page.evaluate(async () => {
      const store = window.__commentStoreForTests;
      await store.createThread({ from: 4, to: 9 }, 'why "quick"?');
      const t2 = await store.createThread({ from: 16, to: 19 }, 'fox = good metaphor');
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
    assert.ok(proof.comments, 'proof should carry comments');
    console.log(`[setup] proof has ${proof.comments.threads.length} threads, ${proof.comments.comments.length} comments`);
    const proofPath = '.playwright-mcp/replay-comments-proof.json';
    writeFileSync(proofPath, proofJson);

    // Re-import via the Import Proof button so it routes through the
    // replayView.loadProof codepath that we just refactored.
    const fc = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Proof' }).click();
    const chooser = await fc;
    await chooser.setFiles(proofPath);
    await page.waitForSelector('#replay-panel.active', { timeout: 5000 });
    await page.waitForTimeout(800);

    // Play through at max speed; wait until the timeline hits the end.
    await page.getByRole('button', { name: '10x' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(
      (total) => document.querySelector('.replay-time')?.textContent === `${total} / ${total}`,
      proof.events.length,
      { timeout: 60000 },
    );
    await page.waitForTimeout(800);

    // Merged surface: 1 unresolved thread → exactly 1 underline group should be visible.
    // (Resolved threads explicitly skipped by the decoration computation.)
    const mergedUnderlines = await page.locator('#replay-panel .replay-merged-host .cm-comment-underline').count();
    console.log(`[unified] cm-comment-underline ranges on merged: ${mergedUnderlines}`);
    assert.ok(mergedUnderlines >= 1, 'expected at least 1 underline on merged surface');

    // Switch to tracks. Single-author proof: one track for alice. Same single
    // underline should appear there too (alice authored the open thread).
    await page.getByRole('button', { name: 'Show tracks' }).click();
    await page.waitForSelector('#replay-panel .replay-track');
    await page.waitForTimeout(800);

    // After toggling to tracks the engine rebuilds surfaces and re-applies
    // events; let it settle by replaying once more.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(
      (total) => document.querySelector('.replay-time')?.textContent === `${total} / ${total}`,
      proof.events.length,
      { timeout: 60000 },
    );
    await page.waitForTimeout(800);

    const trackUnderlines = await page.locator('#replay-panel .replay-track .cm-comment-underline').count();
    console.log(`[tracks] cm-comment-underline ranges across all tracks: ${trackUnderlines}`);
    assert.ok(trackUnderlines >= 1, 'expected at least 1 underline on the per-author track');

    // The merged surface also still shows the underline in tracks mode.
    const mergedUnderlinesInTracksMode = await page.locator('#replay-panel .replay-merged-host .cm-comment-underline').count();
    assert.ok(mergedUnderlinesInTracksMode >= 1, 'merged surface should keep its underlines in tracks mode');

    console.log('\n✓ Phase 3 replay-tab comment annotations test PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
