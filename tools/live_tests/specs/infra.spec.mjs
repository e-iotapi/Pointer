// Reachability of every endpoint the app uses, and the socket's refusal rules.
import { createSign, createPrivateKey } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { CFG, LOCAL, ORIGIN, openLive, idToken, readHead, sleep } from '../lib.mjs';

test('Firestore is reachable', async () => {
  const head = await readHead('goa');
  expect(Object.keys(head).length, 'heads/goa has markers').toBeGreaterThan(0);
});

test('/heads/<campus> answers JSON, 404s an unknown campus', async () => {
  const ok = await fetch(`${CFG.worker}/heads/goa`);
  expect(ok.status).toBe(200);
  expect(typeof (await ok.json())).toBe('object');
  expect((await fetch(`${CFG.worker}/heads/mars`)).status).toBe(404);
});

test('CORS: the app origin is echoed, a stranger is not, OPTIONS is 204', async () => {
  const good = await fetch(`${CFG.worker}/heads/goa`, { headers: { Origin: ORIGIN } });
  expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  const evil = await fetch(`${CFG.worker}/heads/goa`, { headers: { Origin: 'https://evil.example' } });
  expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  expect((await fetch(`${CFG.worker}/heads/goa`, { method: 'OPTIONS', headers: { Origin: ORIGIN } })).status).toBe(204);
});

test('timetable and calendar endpoints answer (200, or 404 when unpublished), never 5xx', async () => {
  for (const p of ['/timetable/goa.json', '/calendar/goa.ics']) {
    const r = await fetch(`${CFG.worker}${p}`);
    expect([200, 404], p).toContain(r.status);
  }
});

test('the socket refuses a missing, malformed or wrong-protocol token', async () => {
  for (const [name, protos] of [['no token', ['pointer']], ['garbage', ['pointer', 'abc.def.ghi']], ['not a jwt', ['pointer', 'x']]]) {
    const ws = new WebSocket(`${CFG.worker.replace(/^http/, 'ws')}/live/goa`, protos);
    const result = await new Promise((res) => {
      ws.onopen = () => res('open');
      ws.onerror = () => res('refused');
      ws.onclose = () => res('refused');
    });
    expect(result, name).toBe('refused');
  }
  expect((await fetch(`${CFG.worker}/live/goa`)).status, 'plain GET').toBe(426);
});

test('a valid token gets hello with the head markers and a me counter', async () => {
  const s = openLive('goa', await idToken('student_full'));
  await s.opened;
  const hello = await s.waitFor((f) => f.t === 'hello');
  s.close();
  expect(hello, 'hello frame').not.toBeNull();
  expect(typeof hello.me).toBe('number');
  const fs = await readHead('goa');
  expect(hello.head.resources, 'hello carries the live marker').toBe(fs.resources);
});

test('an unknown campus is refused', async () => {
  const ws = new WebSocket(`${CFG.worker.replace(/^http/, 'ws')}/live/mars`, ['pointer', await idToken('student_full')]);
  const r = await new Promise((res) => {
    ws.onopen = () => res('open');
    ws.onerror = () => res('refused');
  });
  expect(r).toBe('refused');
});

test('an expired token is refused', async () => {
  test.skip(!LOCAL, 'needs the test signing key');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'test', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${CFG.project}`, aud: CFG.project, sub: 'u1', iat: now - 7200, exp: now - 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(input).sign(createPrivateKey({ key: JSON.parse(process.env.TEST_PRIVATE_JWK), format: 'jwk' })).toString('base64url');
  const ws = new WebSocket(`${CFG.worker.replace(/^http/, 'ws')}/live/goa`, ['pointer', `${input}.${sig}`]);
  const r = await new Promise((res) => {
    ws.onopen = () => res('open');
    ws.onerror = () => res('refused');
  });
  expect(r).toBe('refused');
});

test('a poke after a marker moves pushes a head frame to the same campus', async () => {
  const { bumpHeads } = await import('../lib.mjs');
  const s = openLive('goa', await idToken('student_full'));
  await s.opened;
  await s.waitFor((f) => f.t === 'hello');
  const before = (await readHead('goa')).resources ?? 0;
  await bumpHeads(['goa'], 'resources');
  const from = s.frames.length;
  s.send({ t: 'poke', path: 'resources' });
  const f = await s.waitFor((f) => f.t === 'head' && f.v.resources === before + 1, 10_000, from);
  s.close();
  expect(f, 'head frame with the moved marker').not.toBeNull();
  await sleep(0);
});
