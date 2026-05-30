// Polish — IDB autosave race regression test.
//
// Before the fix: under fast typing, persistNow updated lastPersistedCount
// AFTER saveSession returned, capturing events that arrived during the save
// boundary as "persisted" without actually writing them. Subsequent calls
// then short-circuited (countAtStart === lastPersistedCount) and never
// caught up — the IDB age indicator would freeze at 70s+ in the smoke test.
//
// This test forces the race: type 80 chars in rapid succession (10ms per
// char), wait only one autosave cycle (300ms) past the last keystroke, and
// assert the IDB save reflects the same event count as the in-memory chain.
// Pre-fix this would fail with IDB lagging by 10–60 events.

import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';

const FILE_ID = `phase3-idbrace-${Date.now().toString(36)}`;
const URL = `http://localhost:5175/#${FILE_ID}`;

async function main() {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL);

    await page.getByRole('textbox', { name: 'e.g. david' }).fill('alice');
    await page.getByRole('button', { name: 'Generate Identity' }).click();
    await page.waitForSelector('.cm-content');
    await page.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some((i) => i.textContent === 'Recording'));

    // Fast typing — minimum delay; pressSequentially batches keystrokes into
    // CM transactions that fire much faster than the 250ms IDB autosave
    // interval, so persistNow re-fires while a save is in flight.
    const payload = 'The quick brown fox jumps over the lazy dog. ' +
      'Pack my box with five dozen liquor jugs.';
    await page.locator('.cm-content').click();
    await page.locator('.cm-content').pressSequentially(payload, { delay: 10 });

    // Wait 1.5 seconds — well over one autosave cycle but well under any
    // "manual settle" generous time. Pre-fix, lastIdbSaveAt would be 60s+
    // stale and the IDB doc text would be ~30 chars short.
    await page.waitForTimeout(1500);

    const observed = await page.evaluate(async (fileId) => {
      // Read both the in-memory event counter (from the status bar) and
      // what's actually persisted in IDB.
      const eventsCounter = document.querySelector('.status-bar .status-item:nth-of-type(2)')?.textContent ?? '';
      const inMemCount = parseInt((eventsCounter.match(/\d+/) ?? ['-1'])[0], 10);

      // Open IDB and read the saved snapshot for this fileId.
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('thesis-autosave', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const saved = await new Promise((res) => {
        const tx = db.transaction('session', 'readonly');
        const r = tx.objectStore('session').get(`active:${fileId}`);
        tx.oncomplete = () => { db.close(); res(r.result); };
      });
      return {
        inMemCount,
        idbCount: saved?.events?.length ?? -1,
        idbDocLen: saved?.document?.length ?? -1,
        cmDocLen: document.querySelector('.cm-content')?.textContent?.length ?? -1,
      };
    }, FILE_ID);

    console.log('[idb-race]', observed);
    // The CM doc must reflect everything we typed.
    assert.ok(observed.cmDocLen >= payload.length, `CM doc should have at least ${payload.length} chars, has ${observed.cmDocLen}`);

    // The IDB save must reflect the in-memory chain within one event of it
    // (allowing slop for the very last event that may still be in the hash
    // queue when we snapshot). Pre-fix, the gap was 30+.
    const gap = observed.inMemCount - observed.idbCount;
    console.log(`[idb-race] inMem=${observed.inMemCount} idb=${observed.idbCount} gap=${gap}`);
    assert.ok(
      gap <= 2,
      `IDB lagging in-memory by ${gap} events; expected ≤ 2. Race fix regression?`,
    );

    // Also: IDB document text should match what was typed (or near it).
    assert.ok(
      Math.abs(observed.idbDocLen - observed.cmDocLen) <= 2,
      `IDB doc length ${observed.idbDocLen} diverges from CM ${observed.cmDocLen} by more than 2 chars`,
    );

    console.log('\n✓ IDB autosave race regression test PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
