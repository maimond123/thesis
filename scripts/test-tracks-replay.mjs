// Phase 2 — per-author tracks replay correctness test.
//
// Imports a multi-author proof, toggles the Replay tab into tracks mode,
// plays through to the end, and asserts:
//   * the merged surface ends at proof.finalDocument byte-for-byte
//   * each per-author track ends at the document that results from applying
//     ONLY that author's yjsUpdates to a fresh Y.Doc (which is what each
//     track's underlying Y.Doc is doing inside the page)
//   * author marks on the merged surface use each author's palette index;
//     each track stays monochrome (only the track-owner's palette index)

import { chromium } from 'playwright';
import * as Y from 'yjs';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const FILE_ID = `phase2-tracks-${Date.now().toString(36)}`;
const URL = `http://localhost:5175/#${FILE_ID}`;

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// Produce the document that an author's track Y.Doc would converge to:
// apply only their yjsUpdates to a fresh Y.Doc and read the Y.Text. This is
// the ground truth for what the in-page track surface should display.
function authorTrackExpected(proof, thumb) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('main');
  for (const ev of proof.events) {
    if (ev.authorThumbprint !== thumb) continue;
    if (!ev.yjsUpdate) continue;
    Y.applyUpdateV2(ydoc, b64ToBytes(ev.yjsUpdate));
  }
  return ytext.toString();
}

async function freshProof() {
  // Re-run the multi-author script to produce a guaranteed-fresh v2 proof
  // with two authors and yjsUpdates on every event. We could just reuse the
  // file from disk, but generating fresh confirms the system end-to-end.
  await new Promise((resolve, reject) => {
    const p = spawn('node', ['scripts/test-multi-author.mjs'], { stdio: 'inherit' });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`multi-author script exited ${code}`)));
  });
  return JSON.parse(readFileSync('.playwright-mcp/multi-author-alice.json', 'utf-8'));
}

async function main() {
  const proof = await freshProof();
  console.log(`[setup] proof has ${proof.events.length} events, ${proof.session.authors.length} authors`);
  // Stash a copy at a predictable path for the upload dance.
  const proofPath = '.playwright-mcp/tracks-test-proof.json';
  writeFileSync(proofPath, JSON.stringify(proof));

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL);

    // First-run identity.
    await page.getByRole('textbox', { name: 'e.g. david' }).fill('viewer');
    await page.getByRole('button', { name: 'Generate Identity' }).click();
    await page.waitForSelector('.cm-content');

    // Import proof.
    const importFC = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Proof' }).click();
    const chooser = await importFC;
    await chooser.setFiles(proofPath);
    await page.waitForTimeout(800);

    // We auto-switch to Replay on import.
    await page.waitForSelector('#replay-panel.active', { timeout: 5000 });

    // Toggle into tracks mode + crank speed to 10x.
    await page.getByRole('button', { name: '10x' }).click();
    await page.getByRole('button', { name: 'Show tracks' }).click();
    await page.waitForTimeout(300);

    // Sanity-check the tracks panel built correctly.
    const trackCount = await page.locator('#replay-panel .replay-track').count();
    console.log(`[layout] tracks rendered: ${trackCount}`);
    assert.equal(trackCount, proof.session.authors.length, 'wrong track count');

    // Play through.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(
      (total) => {
        const time = document.querySelector('.replay-time')?.textContent ?? '';
        return time === `${total} / ${total}`;
      },
      proof.events.length,
      { timeout: 60000 },
    );
    await page.waitForTimeout(500);  // let the last few CM updates settle

    // Verify merged + tracks state.
    const observed = await page.evaluate(() => {
      const merged = document.querySelector('#replay-panel .replay-merged-host .cm-content')?.textContent ?? '';
      // CodeMirror's textContent includes y-codemirror remote-cursor widgets;
      // we have to strip those (zero-width space U+2060 / U+2061 surrounds them).
      const stripWidget = (s) => s.replace(/⁠+[\s\S]*?⁠/g, '');
      const tracks = Array.from(document.querySelectorAll('#replay-panel .replay-track')).map((t) => {
        // Handle is the second child of .replay-track-head (the first is the
        // swatch span, the third is .replay-track-status). textContent of the
        // whole head now also includes the status hint.
        const head = t.querySelector('.replay-track-head');
        const handleSpan = head?.querySelectorAll('span')[1];
        const handle = handleSpan?.textContent?.trim() ?? '';
        const status = t.querySelector('.replay-track-status')?.textContent ?? '';
        const text = t.querySelector('.cm-content')?.textContent ?? '';
        const swatchClass = t.querySelector('.replay-track-head .replay-legend-swatch')?.className ?? '';
        const markClasses = new Set(
          Array.from(t.querySelectorAll('.cm-content .cm-author')).map((m) =>
            Array.from(m.classList).find((c) => c.startsWith('cm-author-')) ?? '',
          ),
        );
        return {
          head: handle,
          status,
          text: stripWidget(text),
          headSwatchClass: swatchClass,
          markClasses: [...markClasses].filter(Boolean),
        };
      });
      // Merged author-mark colours used:
      const mergedMarkClasses = Array.from(
        new Set(
          Array.from(document.querySelectorAll('#replay-panel .replay-merged-host .cm-content .cm-author')).map((m) =>
            Array.from(m.classList).find((c) => c.startsWith('cm-author-')) ?? '',
          ),
        ),
      ).filter(Boolean);
      return {
        merged: stripWidget(merged),
        mergedMarkClasses,
        tracks,
      };
    });

    console.log(`[merged] ${JSON.stringify(observed.merged.slice(0, 80))}...`);
    for (const t of observed.tracks) {
      console.log(`[track ${t.head}] status="${t.status}" text=${JSON.stringify(t.text.slice(0, 80))}... marks=${t.markClasses.join(',')}`);
    }

    // 1. Merged surface == finalDocument.
    assert.equal(observed.merged, proof.finalDocument, 'merged surface text != finalDocument');

    // 2. Each per-author track == authorTrackExpected(proof, thumb).
    // Map track-by-label to author thumbprint via the roster (we labelled the
    // track head with the handle).
    const handleToThumb = new Map(proof.session.authors.map((a) => [a.handle, a.thumbprint]));
    for (const t of observed.tracks) {
      // The track-head label is "{swatch}{handle}". The DOM puts text adjacent
      // to the swatch span, so trim and the handle is what's left.
      const handle = t.head.trim();
      const thumb = handleToThumb.get(handle);
      assert.ok(thumb, `couldn't resolve thumbprint for track labelled "${handle}"`);
      const expected = authorTrackExpected(proof, thumb);
      assert.equal(
        t.text, expected,
        `track ${handle}: got ${JSON.stringify(t.text.slice(0, 60))}, expected ${JSON.stringify(expected.slice(0, 60))}`,
      );
    }

    // 3. Merged should use BOTH author palette indices; each track should use
    // exactly ONE (its own).
    assert.ok(observed.mergedMarkClasses.length >= 2, `merged surface marks span ${observed.mergedMarkClasses.length} colours; expected ≥ 2`);
    for (const t of observed.tracks) {
      assert.equal(
        t.markClasses.length, 1,
        `track ${t.head}: mark classes ${t.markClasses.join(',')}, expected exactly one`,
      );
      // And the one mark colour must match the head swatch colour.
      const swatchColour = (t.headSwatchClass.match(/cm-author-\d+/) ?? [''])[0];
      assert.equal(t.markClasses[0], swatchColour, `track ${t.head}: marks ${t.markClasses[0]} ≠ swatch ${swatchColour}`);
    }

    // 4. Seek midway, verify both merged + tracks rebuild correctly.
    const mid = Math.floor(proof.events.length / 2);
    await page.evaluate((idx) => {
      // The progress wrap has the click handler; simulate a click at the
      // x-position matching idx/total.
      const wrap = document.querySelector('.replay-progress');
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const total = parseInt(document.querySelector('.replay-time').textContent.split(' / ')[1], 10);
      const fraction = idx / total;
      const evDown = new MouseEvent('mousedown', { clientX: rect.left + rect.width * fraction, clientY: rect.top + rect.height / 2, bubbles: true });
      wrap.dispatchEvent(evDown);
      const evUp = new MouseEvent('mouseup', { clientX: rect.left + rect.width * fraction, clientY: rect.top + rect.height / 2, bubbles: true });
      window.dispatchEvent(evUp);
    }, mid);
    await page.waitForTimeout(800);

    const midObserved = await page.evaluate(() => {
      const stripWidget = (s) => s.replace(/⁠+[\s\S]*?⁠/g, '');
      return {
        time: document.querySelector('.replay-time')?.textContent,
        mergedLen: stripWidget(document.querySelector('#replay-panel .replay-merged-host .cm-content')?.textContent ?? '').length,
        trackLens: Array.from(document.querySelectorAll('#replay-panel .replay-track .cm-content'))
          .map((el) => stripWidget(el.textContent ?? '').length),
      };
    });
    console.log(`[seek to ${mid}] time=${midObserved.time} mergedLen=${midObserved.mergedLen} trackLens=${midObserved.trackLens.join(',')}`);
    assert.match(midObserved.time, new RegExp(`^${mid} / `), `time label should show ${mid} / N`);
    // After seeking back, surface lens should be smaller than final.
    assert.ok(midObserved.mergedLen < observed.merged.length, 'merged should have shrunk after backwards seek');
    for (let i = 0; i < midObserved.trackLens.length; i++) {
      assert.ok(
        midObserved.trackLens[i] <= observed.tracks[i].text.length,
        `track ${i}: post-seek length ${midObserved.trackLens[i]} > final length ${observed.tracks[i].text.length}`,
      );
    }

    console.log('\n✓ Phase 2 tracks replay test PASSED');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
