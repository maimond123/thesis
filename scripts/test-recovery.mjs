// Phase 1 recovery correctness test.
//
// Type some characters, kill the tab, reopen the same fileId, verify:
//   - The doc auto-recovers with the same content
//   - Continuing to type appends fresh signed events to the SAME chain
//     (seq continues monotonically, prev-hash links)
//   - Export verifies cleanly

import { chromium } from 'playwright';
import * as Y from 'yjs';
import { strict as assert } from 'node:assert';

const FILE_ID = `phase1-recovery-${Date.now().toString(36)}`;
const URL_BASE = `http://localhost:5175/#${FILE_ID}`;

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

async function main() {
  const browser = await chromium.launch();
  // Persistent context with a unique user-data dir so the second open shares
  // IndexedDB with the first.
  const userDataDir = `/tmp/thesis-recovery-${Date.now()}`;
  await browser.close();

  const ctx = await chromium.launchPersistentContext(userDataDir);
  try {
    // ── Session 1: initial typing ──────────────────────────────────────
    let page = await ctx.newPage();
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
    await page.goto(URL_BASE);

    // First-run modal
    await page.getByRole('textbox', { name: 'e.g. david' }).fill('alice');
    await page.getByRole('button', { name: 'Generate Identity' }).click();
    await page.waitForSelector('.cm-content');
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some(i => i.textContent === 'Recording'));

    const part1 = 'Paragraph one. '.repeat(8); // 120 chars
    await page.locator('.cm-content').click();
    await page.locator('.cm-content').pressSequentially(part1, { delay: 20 });
    await page.waitForTimeout(2500);

    const beforeKill = await page.evaluate(() => document.querySelector('.cm-content').textContent);
    console.log(`[before kill] cm has ${beforeKill.length} chars`);
    assert.ok(beforeKill.includes('Paragraph one. Paragraph one. Paragraph one.'), 'pre-kill text missing');

    // Capture event count before reload by force-flush via end+start? No —
    // we want to SIMULATE a kill, so close the page WITHOUT ending the
    // session. SessionManager.forceSaveSync runs on beforeunload.
    await page.close();
    console.log('[killed] page closed without ending session');

    // ── Session 2: reopen, expect recovery ─────────────────────────────
    page = await ctx.newPage();
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
    await page.goto(URL_BASE);

    // Wait for recovery — status bar shows Recording.
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some(i => i.textContent === 'Recording'), { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Confirm recovered text matches.
    const afterRecover = await page.evaluate(() => document.querySelector('.cm-content').textContent);
    console.log(`[after recover] cm has ${afterRecover.length} chars`);
    assert.equal(afterRecover, beforeKill, 'recovered text differs from pre-kill');

    // Type more.
    const part2 = ' Recovered chunk added later.';
    await page.locator('.cm-content').click();
    await page.locator('.cm-content').pressSequentially(part2, { delay: 25 });
    await page.waitForTimeout(2000);

    const afterMore = await page.evaluate(() => document.querySelector('.cm-content').textContent);
    console.log(`[after more] cm has ${afterMore.length} chars`);
    assert.ok(afterMore.includes('Recovered chunk added later.'), 'post-recovery text not appended');

    // End + export, then assert proof verifies + replays cleanly.
    await page.getByRole('button', { name: 'End Session' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Export Proof' }).click();
    await page.waitForTimeout(500);
    const proofJson = await page.evaluate(() => window.__lastProofJson);
    const proof = JSON.parse(proofJson);
    console.log(`[proof] version=${proof.version} events=${proof.events.length} authors=${new Set(proof.events.map(e => e.authorThumbprint)).size}`);
    assert.equal(proof.version, 2, 'proof must be v2');
    assert.equal(new Set(proof.events.map(e => e.authorThumbprint)).size, 1, 'recovery should keep single author');

    // Per-author chain seqs must be continuous 0..N-1 (chain integrity is the
    // tamper-evident property; cross-author event ordering in the proof is
    // sorted by timestamp, which is per-page-load relative — pre-kill and
    // post-recovery events end up shuffled, but that's harmless because Yjs
    // updates are commutative so replay reconstructs the same final state).
    const byAuthor = new Map();
    for (const ev of proof.events) {
      const arr = byAuthor.get(ev.authorThumbprint) ?? [];
      arr.push(ev);
      byAuthor.set(ev.authorThumbprint, arr);
    }
    for (const [thumb, evs] of byAuthor) {
      evs.sort((a, b) => a.seq - b.seq);
      for (let i = 0; i < evs.length; i++) {
        assert.equal(
          evs[i].seq,
          i,
          `seq gap at index ${i} for author ${thumb.slice(0, 8)}: got ${evs[i].seq}`,
        );
      }
    }

    // Replay through Yjs == finalDocument.
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('main');
    for (const ev of proof.events) {
      Y.applyUpdateV2(ydoc, b64ToBytes(ev.yjsUpdate));
    }
    const replayed = ytext.toString();
    assert.equal(replayed, proof.finalDocument, 'replay diverged from finalDocument');
    console.log(`[replay] ${JSON.stringify(replayed.slice(0, 80))}...`);

    // Drive in-app Verify to assert full pipeline passes.
    await page.getByRole('button', { name: 'Verify' }).click();
    const fcPromise = page.waitForEvent('filechooser');
    await page.getByText('Drop a .proof.json file here').click();
    const chooser = await fcPromise;
    // Write to temp + import
    const tmpPath = `/tmp/thesis-recovery-proof.json`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(tmpPath, proofJson);
    await chooser.setFiles(tmpPath);
    await page.waitForSelector('text=PROOF VALID', { timeout: 10000 });
    const verifySummary = await page.evaluate(() => {
      const t = document.querySelector('#verify-panel')?.textContent ?? '';
      return {
        valid: t.includes('PROOF VALID'),
        chains: t.match(/Hash chains intact \([^)]*\)/)?.[0],
        doc: t.match(/Replayed document matches finalDocument|cannot verify/)?.[0],
        sig: t.match(/Final session signature is valid|invalid/)?.[0],
      };
    });
    console.log('[verify after recovery]', verifySummary);
    assert.ok(verifySummary.valid, 'recovery proof not valid');
    assert.equal(verifySummary.doc, 'Replayed document matches finalDocument', 'doc consistency failed');
    assert.equal(verifySummary.sig, 'Final session signature is valid', 'sig invalid');

    console.log('\n✓ Recovery preserves Y.Doc state test PASSED');
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
