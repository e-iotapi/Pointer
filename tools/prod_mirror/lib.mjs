// Shared by export / anonymise / load / synth. No real project is ever named
// here except to refuse it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROD_PROJECT_ID = 'cgpa-calculator-fb90c';
export const EMULATOR_PROJECT = 'demo-pointer';
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** `--flag value` and bare `--flag` parser. */
export function parseArgs(argv, bools = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    out[k] = bools.includes(k) ? true : argv[++i];
  }
  return out;
}

// ---- typed JSON ------------------------------------------------------------
// Timestamp -> {__t:'ts',s,n}; GeoPoint -> {__t:'geo'}; Bytes -> {__t:'bytes'};
// DocumentReference -> {__t:'ref'}; a plain map that itself has a `__t` key is
// wrapped as {__t:'map',v}. Every other value is plain JSON.

export function encode(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return { __t: 'num', v: String(v) };
    return v;
  }
  if (Array.isArray(v)) return v.map(encode);
  const name = v.constructor?.name;
  if (name === 'Timestamp') return { __t: 'ts', s: v.seconds, n: v.nanoseconds };
  if (name === 'GeoPoint') return { __t: 'geo', lat: v.latitude, lng: v.longitude };
  if (name === 'DocumentReference') return { __t: 'ref', path: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __t: 'bytes', b64: Buffer.from(v).toString('base64') };
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = encode(x);
  return '__t' in o ? { __t: 'map', v: o } : o;
}

export function decode(j, { Timestamp, GeoPoint, db } = {}) {
  if (j === null || typeof j !== 'object') return j;
  if (Array.isArray(j)) return j.map((x) => decode(x, { Timestamp, GeoPoint, db }));
  switch (j.__t) {
    case 'ts': return new Timestamp(j.s, j.n);
    case 'geo': return new GeoPoint(j.lat, j.lng);
    case 'ref': return db.doc(j.path);
    case 'bytes': return Buffer.from(j.b64, 'base64');
    case 'num': return Number(j.v);
    case 'map': return decode(j.v, { Timestamp, GeoPoint, db });
  }
  const o = {};
  for (const [k, x] of Object.entries(j)) o[k] = decode(x, { Timestamp, GeoPoint, db });
  return o;
}

// ---- export directory ------------------------------------------------------
// <dir>/docs.jsonl, one {"path","data"} per line (the format of the owner's
// prod_export_now.mjs); <dir>/auth.json as `firebase auth:export` writes it
// ({users:[{localId,email,displayName,disabled,...}]}); <dir>/manifest.json.
// Older layouts with data/*.ndjson are read too.

export function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Every doc of an export or anonymised directory, deduped by path, sorted. */
export function readDocs(dir) {
  const files = [];
  if (existsSync(path.join(dir, 'docs.jsonl'))) files.push(path.join(dir, 'docs.jsonl'));
  const dataDir = path.join(dir, 'data');
  if (existsSync(dataDir)) for (const f of readdirSync(dataDir).sort()) if (f.endsWith('.ndjson')) files.push(path.join(dataDir, f));
  if (!files.length) throw new Error(`${dir} has no docs.jsonl: not an export.`);
  const byPath = new Map();
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      byPath.set(r.path, r);
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Auth users as {uid,email,displayName,disabled}, from auth:export or our own shape. */
export function readAuth(dir) {
  const f = path.join(dir, 'auth.json');
  if (!existsSync(f)) return [];
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return (j.users ?? []).map((u) => ({
    uid: u.localId ?? u.uid, email: u.email ?? null, displayName: u.displayName ?? null, disabled: u.disabled ?? false,
  }));
}

export function writeDocs(dir, docs, auth) {
  writeJsonl(path.join(dir, 'docs.jsonl'), [...docs].sort((a, b) => (a.path < b.path ? -1 : 1)));
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    users: auth.map((u) => ({ localId: u.uid, email: u.email, displayName: u.displayName, disabled: u.disabled })),
  }, null, 1));
}

// ---- rules-derived collection list ----------------------------------------

/** Top-level collections and subcollection names named by firestore.rules. */
export function collectionsFromRules(rulesText = readFileSync(path.join(root, 'firestore.rules'), 'utf8')) {
  const top = new Set(), sub = new Set();
  for (const line of rulesText.split('\n')) {
    let m;
    if ((m = /^\s{4}match \/([A-Za-z]\w*)\//.exec(line))) top.add(m[1]);
    // match /courses/{c}/offerings/{o}   match /{path=**}/entries/{id}
    if ((m = /^\s{4}match \/(?:[A-Za-z]\w*\/\{\w+\}|\{path=\*\*\})\/([A-Za-z]\w*)\//.exec(line))) sub.add(m[1]);
    // nested: match /votes/{v} inside an entries block
    if ((m = /^\s{6,}match \/([A-Za-z]\w*)\/\{/.exec(line))) sub.add(m[1]);
  }
  // A name that is also a top-level collection (reports) is read by collection group,
  // which covers both (e.g. reports).
  return { top: [...top].filter((t) => !sub.has(t)).sort(), sub: [...sub].sort() };
}

/** Pacific calendar day: Spark quotas reset at midnight Pacific. */
export const pacificDay = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

/** Real data must never land in the repo: only outside it, or in the ignored folder. */
export function assertSafeDir(p, what) {
  const abs = path.resolve(p);
  const rel = path.relative(root, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside && !rel.startsWith('sensitive_data_NO_COMMIT' + path.sep)) {
    throw new Error(`${what} ${abs} is inside the repository. Use a path outside it, or under sensitive_data_NO_COMMIT/ (git-ignored).`);
  }
  return abs;
}
