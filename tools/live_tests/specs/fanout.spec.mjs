// The hub is per campus. A write can move another campus's head, or every campus's, and the person it
// concerns can be on a third campus: the Worker must still reach them (server-side fan-out of pokes).
import { test, expect } from '@playwright/test';
import { openLive, idToken, bumpHeads, readHead, email, sleep } from '../lib.mjs';

const CAMPUSES = ['goa', 'hyderabad', 'pilani', 'dubai'];

async function connect(campus, key) {
  const s = openLive(campus, await idToken(key));
  await s.opened;
  await s.waitFor((f) => f.t === 'hello');
  return s;
}

test('a write on another campus\'s head reaches that campus\'s clients', async () => {
  const owner = await connect('goa', 'owner'); // an owner on Goa view acts on Hyderabad
  const hyd = await connect('hyderabad', 'student_hyd');
  const before = (await readHead('hyderabad')).resources ?? 0;
  await bumpHeads(['hyderabad'], 'resources');
  const from = hyd.frames.length;
  owner.send({ t: 'poke', path: 'resources', campuses: ['hyderabad'] });
  const f = await hyd.waitFor((f) => f.t === 'head' && f.v.resources === before + 1, 10_000, from);
  owner.close();
  hyd.close();
  expect(f, 'Hyderabad student told of a Hyderabad write made from the Goa hub').not.toBeNull();
});

test('an every-campus write (terms, grants, roles) reaches every campus', async () => {
  const owner = await connect('goa', 'owner');
  const others = [];
  for (const c of ['hyderabad', 'pilani', 'dubai']) others.push([c, await connect(c, c === 'hyderabad' ? 'student_hyd' : 'student_full')]);
  const before = (await readHead('hyderabad')).terms ?? 0;
  await bumpHeads(CAMPUSES, 'terms');
  const from = others.map(([, s]) => s.frames.length);
  owner.send({ t: 'poke', path: 'terms', campuses: CAMPUSES });
  const got = [];
  for (const [i, [c, s]] of others.entries()) got.push([c, await s.waitFor((f) => f.t === 'head' && 'terms' in f.v, 10_000, from[i])]);
  owner.close();
  others.forEach(([, s]) => s.close());
  for (const [c, f] of got) expect(f, `${c} told of the every-campus marker`).not.toBeNull();
  void before;
});

test('pokeUser reaches the person\'s sockets on another campus, as a roles frame', async () => {
  const owner = await connect('goa', 'owner');
  const hyd = await connect('hyderabad', 'student_hyd');
  const bystander = await connect('hyderabad', 'student_full');
  const from = [hyd.frames.length, bystander.frames.length];
  owner.send({ t: 'pokeUser', email: email('student_hyd') });
  const f = await hyd.waitFor((f) => f.t === 'roles', 6000, from[0]);
  await sleep(500);
  const stray = bystander.frames.slice(from[1]).some((x) => x.t === 'roles');
  owner.close();
  hyd.close();
  bystander.close();
  expect(f, 'grantee told their roles changed').not.toBeNull();
  expect(stray, 'nobody else is told').toBe(false);
});

test('pokeUser is rate-limited and carries no data', async () => {
  const owner = await connect('goa', 'owner');
  const s = await connect('goa', 'student_full');
  const from = s.frames.length;
  for (let i = 0; i < 20; i++) owner.send({ t: 'pokeUser', email: email('student_full') });
  await sleep(2500);
  const roles = s.frames.slice(from).filter((f) => f.t === 'roles');
  owner.close();
  s.close();
  expect(roles.length, 'a burst of 20 gives the target one or two re-reads').toBeGreaterThan(0);
  expect(roles.length).toBeLessThanOrEqual(2);
  expect(Object.keys(roles[0]).sort(), 'only the frame type and a counter travel').toEqual(['at', 't', 'v']);
});
