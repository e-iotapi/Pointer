// The seed's marker bump stays under Firestore's 500 field transforms per
// document write (a staging head holding a mirror's offerings broke the reseed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markerBumps } from './seed.mjs';

test('every marker is bumped once, in writes of at most 450 keys', () => {
  const offerings = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`C ${i}`, 3]));
  const chunks = markerBumps({ v: { resources: 4, grants: 2 }, offerings }, ['grants', 'leaderboard']);
  for (const c of chunks) assert.ok(Object.keys(c.v).length + Object.keys(c.offerings).length <= 450);
  assert.deepEqual(chunks.flatMap((c) => Object.keys(c.v)).sort(), ['grants', 'leaderboard', 'resources']);
  assert.equal(chunks.reduce((n, c) => n + Object.keys(c.offerings).length, 0), 1200);
});

test('an empty head still gets the new markers', () => {
  assert.deepEqual(markerBumps({}, ['grants']), [{ v: { grants: 1 }, offerings: {} }]);
});
