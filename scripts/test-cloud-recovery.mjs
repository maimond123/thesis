// Cloud-sync recovery test.
//
// Mocks /api/sessions via Playwright page.route() so the test doesn't need
// the real Vercel-backed cloud endpoint. Records a session in tab A (which
// PUTs to the mocked cloud), reloads to a fresh fileId in tab B (same
// persistent context so the same alice identity is kept), clicks Load
// Session, picks the captured session, and verifies recoverFromCloud
// restores the events + finalDocument.
//
// What this validates beyond the IDB recovery test:
//   - cloudSave PUT body shape (the same SavedSession shape persistence.ts
//     uses, plus a savedAt timestamp)
//   - cloudList GET response shape ({ sessions: [{ id, size, updatedAt }] })
//   - cloudLoad GET response shape (full CloudSession body)
//   - recoverFromCloud's restoreLiveDocument + loadComments path on the
//     cloud branch (recover() and recoverFromCloud share the same helpers,
//     but the data sources differ)

import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';

const RECORDING_FILE_ID = `phase-cloud-${Date.now().toString(36)}`;
const RECOVERY_FILE_ID = `phase-cloud-recover-${Date.now().toString(36)}`;
const REC_URL = `http://localhost:5175/#${RECORDING_FILE_ID}`;
const RECOV_URL = `http://localhost:5175/#${RECOVERY_FILE_ID}`;
const USER_DATA_DIR = `/tmp/thesis-cloud-recovery-${Date.now()}`;

async function setupRoutes(ctx, cloudStore) {
  await ctx.route('**/api/sessions*', async (route, req) => {
    const url = new URL(req.url());
    const id = url.searchParams.get('id');
    const method = req.method();
    if (method === 'PUT' && id) {
      let body;
      try {
        body = JSON.parse(req.postData() ?? '{}');
      } catch {
        body = {};
      }
      cloudStore.set(id, body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else if (method === 'GET' && id) {
      const body = cloudStore.get(id);
      if (!body) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
    } else if (method === 'GET' && !id) {
      // List endpoint.
      const sessions = [...cloudStore.entries()].map(([sid, body]) => ({
        id: sid,
        size: JSON.stringify(body).length,
        updatedAt: body?.savedAt ?? new Date().toISOString(),
      }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions }) });
    } else if (method === 'DELETE' && id) {
      cloudStore.delete(id);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      await route.fulfill({ status: 405 });
    }
  });
}

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR);
  const cloudStore = new Map();
  await setupRoutes(ctx, cloudStore);

  try {
    // ── Tab A: record + comment + auto-cloud-save ──────────────────
    const tabA = await ctx.newPage();
    await tabA.goto(REC_URL);
    await tabA.getByRole('textbox', { name: 'e.g. david' }).fill('alice');
    await tabA.getByRole('button', { name: 'Generate Identity' }).click();
    await tabA.waitForSelector('.cm-content');
    await tabA.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some((i) => i.textContent === 'Recording'));

    // Type something and create a thread.
    await tabA.locator('.cm-content').click();
    await tabA.locator('.cm-content').pressSequentially('The quick brown fox.', { delay: 30 });
    await tabA.waitForTimeout(2000);
    await tabA.evaluate(async () => {
      await window.__commentStoreForTests.createThread({ from: 4, to: 9 }, 'on "quick"');
    });
    // Wait for at least one full cloud-save cycle (10s default).
    await tabA.waitForTimeout(12000);
    // Verify the cloud store actually received a PUT.
    assert.ok(cloudStore.size >= 1, 'cloud should have received at least one session PUT');
    const sessionId = [...cloudStore.keys()][0];
    const cloudBody = cloudStore.get(sessionId);
    console.log(`[cloud] saved session ${sessionId.slice(0, 8)}…: ${cloudBody.events?.length ?? 0} events, ${cloudBody.comments?.threads?.length ?? 0} threads`);
    assert.ok(cloudBody.events.length > 0, 'cloud body should have events');
    assert.equal(cloudBody.comments.threads.length, 1, 'cloud body should have the thread');

    // End + close tab A. We DO NOT end the session via the button because
    // end() clears the IDB record AND deletes from cloud — for the test we
    // want the cloud entry to persist. Just close the page.
    await tabA.close();

    // ── Tab B: same context (identity persists), fresh fileId so IDB
    // doesn't auto-recover. Click Load Session, pick alice's saved one.
    const tabB = await ctx.newPage();
    await tabB.goto(RECOV_URL);
    await tabB.waitForSelector('.cm-content');
    await tabB.waitForFunction(() => Array.from(
      document.querySelectorAll('.status-bar .status-item'),
    ).some((i) => i.textContent === 'Recording'));
    // The fresh fileId auto-starts a new session — that's the "no recovery"
    // state. Now click Load Session to recover from the cloud.

    // Confirm the new fileId doesn't already have alice's text (it's a
    // separate room).
    const preLoadText = await tabB.evaluate(() => window.__commentStoreForTests['yText'].toString());
    console.log(`[tab B pre-load] Y.Text: ${JSON.stringify(preLoadText)}`);

    // Click Load Session. The dialog accepts a confirm prompt about ending
    // current session — auto-accept via dialog handler.
    tabB.on('dialog', (d) => d.accept());
    await tabB.getByRole('button', { name: 'Load Session' }).click();

    // The picker is a custom div, not a native dialog. Look for the saved
    // session ID text and click its row.
    await tabB.waitForSelector('text=Load Cloud Session', { timeout: 5000 });
    // The row's text starts with the session ID.
    await tabB.locator(`text=${sessionId}`).click();
    await tabB.waitForTimeout(1500);

    // After recovery, the Y.Text should match what alice had typed.
    const postLoadText = await tabB.evaluate(() => window.__commentStoreForTests['yText'].toString());
    console.log(`[tab B post-load] Y.Text: ${JSON.stringify(postLoadText)}`);
    assert.equal(postLoadText, 'The quick brown fox.', 'tab B should have recovered alice\'s text');

    // Comments should be present too.
    const threadCount = await tabB.evaluate(() => window.__commentStoreForTests.listThreads().length);
    console.log(`[tab B] recovered thread count: ${threadCount}`);
    assert.equal(threadCount, 1, 'tab B should have alice\'s thread restored');

    console.log('\n✓ Cloud-sync recovery test PASSED');
  } finally {
    await ctx.close();
  }
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
