// Failure modes: the app must keep working and recover by itself.
import { test, expect } from '@playwright/test';
import { LOCAL, CFG, installLocalCanvasKit, openLive, idToken, bumpHeads, readHead, sleep } from '../helpers.mjs';

test('socket drop: a reconnecting client is told of a marker that moved meanwhile', async () => {
  const s1 = openLive('goa', await idToken('student_full'));
  await s1.opened;
  await s1.waitFor((f) => f.t === 'hello');
  s1.close();
  await bumpHeads(['goa'], 'resources');
  const s2 = openLive('goa', await idToken('student_full'));
  await s2.opened;
  await s2.waitFor((f) => f.t === 'hello'); // may hold the hub's 60 s cached head
  s2.send({ t: 'poke', path: 'resources' });
  const want = (await readHead('goa')).resources;
  const f = await s2.waitFor((f) => (f.t === 'head' && f.v.resources === want) || (f.t === 'hello' && f.head.resources === want), 10_000);
  s2.close();
  expect(f, 'the moved marker arrives after a reconnect').not.toBeNull();
});

test.describe('app', () => {
  test.skip(!LOCAL, 'browser checks run on the local build');

  test('Worker unreachable: the app still loads and shows shared data via Firestore heads', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: CFG.app });
    await context.route(`${CFG.worker}/**`, (r) => r.abort());
    await context.routeWebSocket(/127\.0\.0\.1:8793/, (ws) => ws.close());
    const page = await context.newPage();
    await installLocalCanvasKit(page);
    await page.goto('/more/resources/A3?as=student_full');
    const later = page.getByRole('button', { name: 'Not now' });
    await later.first().waitFor({ timeout: 8000 }).then(() => later.first().click()).catch(() => {});
    await expect(page.getByRole('button', { name: 'More options for this link' }).first()).toBeVisible({ timeout: 40_000 });
    await context.close();
  });

  test('socket drop and recovery: after the connection is cut the app reconnects and goes on receiving', async ({ browser }) => {
    let opens = 0;
    const context = await browser.newContext({ baseURL: CFG.app });
    const page = await context.newPage();
    await installLocalCanvasKit(page);
    await page.routeWebSocket(/127\.0\.0\.1:8793\/live/, (ws) => {
        opens++;
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => ws.send(m));
        if (opens === 1) setTimeout(() => ws.close(), 6000); // cut the first connection
    });
    await page.goto('/settings?as=student_full');
    await expect.poll(() => opens, { timeout: 60_000, message: 'the app opens a second socket after the drop' }).toBeGreaterThanOrEqual(2);
    await context.close();
  });
});
