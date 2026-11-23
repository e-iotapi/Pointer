// Replay engine: the same scenario, as each production actor, on the same seeded data,
// under the OLD rules, the NEW rules, and the NEW rules + roles/builtin. Runs under the
// emulator (run.mjs starts it). Env: BT_OLD_RULES, BT_NEW_RULES (files), BT_OUT (jsonl),
// BT_FIXTURE (json, default fixtures/prod_shapes.json), BT_EXPORT (optional emulator-less
// JSON dump of docs {path: data} laid over the fixture), BT_ONLY (scenario id regex).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { scenarios as base } from './scenarios.mjs';
import { corruption } from './corruption.mjs';

const { doc, setDoc, Timestamp } = fs;
const fixture = JSON.parse(readFileSync(process.env.BT_FIXTURE, 'utf8'));
const A = fixture.actors;
const overlay = process.env.BT_EXPORT ? JSON.parse(readFileSync(process.env.BT_EXPORT, 'utf8')) : {};

const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if ('$ts' in v) return Timestamp.fromMillis(Date.now() + v.$ts * 864e5);
    if ('$tsMs' in v) return Timestamp.fromMillis(v.$tsMs);
    return Object.fromEntries(Object.entries(v).filter(([, x]) => !(x && typeof x === 'object' && '$delete' in x)).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};
const builtinDoc = () => {
  const caps = JSON.parse(readFileSync(new URL('./fixtures/default_caps.json', import.meta.url), 'utf8'));
  return { admin: { caps: caps.admin, termDays: 730 }, president: { caps: caps.president, termDays: 365 }, cr: { caps: caps.cr, termDays: 183 } };
};

const ENVS = [
  { key: 'old', project: 'demo-bt-old', rules: process.env.BT_OLD_RULES },
  { key: 'new', project: 'demo-bt-new', rules: process.env.BT_NEW_RULES },
  { key: 'newB', project: 'demo-bt-newb', rules: process.env.BT_NEW_RULES, builtin: true },
];
for (const e of ENVS) {
  e.env = await initializeTestEnvironment({ projectId: e.project, firestore: { rules: readFileSync(e.rules, 'utf8'), host: '127.0.0.1', port: 8085 } });
}

async function reseed(e, extra = {}) {
  await e.env.clearFirestore();
  await e.env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const all = { ...fixture.docs, ...overlay, ...extra };
    for (const [p, data] of Object.entries(all)) {
      if (data === null) continue; // an overlay entry of null removes the fixture doc
      await setDoc(doc(db, ...p.split('/')), revive(data));
    }
    if (e.builtin && !('roles/builtin' in all)) await setDoc(doc(db, 'roles', 'builtin'), builtinDoc());
  });
}
const as = (e, email) => e.env.authenticatedContext(`uid-${email.split('@')[0]}`, { email, email_verified: true, name: `Name of ${email.split('@')[0]}` }).firestore();

const h = { ...fs, A, days: (n) => Timestamp.fromMillis(Date.now() + n * 864e5), name: (x) => `Name of ${x.split('@')[0]}` };
const only = process.env.BT_ONLY ? new RegExp(process.env.BT_ONLY) : null;
const list = [...base(h), ...corruption(h)].filter((s) => !only || only.test(s.id));
const out = process.env.BT_OUT; writeFileSync(out, '');
const run = async (e, s, who) => {
  try { await s.run(h, as(e, A[who]), A[who], who); return { ok: true }; }
  catch (x) { return { ok: false, err: String(x.message ?? x).split('\n')[0].slice(0, 200) }; }
};
let dirty = true; // every env starts clean; any scenario that may write dirties it
for (const s of list) {
  const actors = s.actors === 'all' || !s.actors ? Object.keys(A).filter((k) => k !== 'TARGET') : s.actors;
  for (const who of actors) {
    const row = { id: s.id, area: s.area, actor: who, expectNew: s.expectNew, info: s.info };
    for (const e of ENVS) {
      if (dirty || s.seed) await reseed(e, s.seed);
      row[e.key] = await run(e, s, who);
    }
    dirty = s.w !== false || !!s.seed;
    appendFileSync(out, JSON.stringify(row) + '\n');
  }
}
for (const e of ENVS) await e.env.cleanup();
