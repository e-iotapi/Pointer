#!/usr/bin/env node
// COMBINE: one dataset out of several (anonymised prod,
// a synthetic set), so one load writes it all and nothing overwrites anything.
//
//   node tools/prod_mirror/combine.mjs --out <dir> <first> <second> [<third> …]
//
// Documents that exist in one set only are copied. Where paths collide, the
// FIRST set wins, except for shared documents that are maps of independent
// entries, which are merged (their counters summed or kept as the max):
// heads markers, repIndex, reviewIndex and review mirrors, review stats,
// resourceVersions, leaderboard, searchHints, activity, pending.
// The catalogue, config, timetable and offerings come from the first set that
// has them. A set whose manifest says `synthetic` has its professors replaced
// by the earlier sets' professors of the same campus and department (reviews,
// stats and offerings follow), so it reuses real professors and courses.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAuth, readDocs, writeDocs } from './lib.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && !v.__t;
const maxMerge = (a = {}, b = {}) => {
  const o = { ...b, ...a };
  for (const k of Object.keys(a)) if (typeof a[k] === 'number' && typeof b[k] === 'number') o[k] = Math.max(a[k], b[k]);
  return o;
};
const sumInto = (a = {}, b = {}) => {
  const o = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = (a[k] ?? { count: 0, starSum: 0, recommendCount: 0 });
  for (const k of Object.keys(b)) if (k in a) o[k] = { ...a[k], count: a[k].count + b[k].count, starSum: a[k].starSum + b[k].starSum, recommendCount: a[k].recommendCount + b[k].recommendCount };
  for (const k of Object.keys(b)) if (!(k in a)) o[k] = b[k];
  return o;
};
const deepSum = (a = {}, b = {}) => {
  const o = { ...b };
  for (const [k, v] of Object.entries(a)) o[k] = isObj(v) && isObj(b[k]) ? deepSum(v, b[k]) : typeof v === 'number' && typeof b[k] === 'number' ? v + b[k] : v;
  return o;
};

/** [a] is what is there, [b] the newcomer; returns the merged data, or undefined to keep [a] as it is. */
const MERGERS = [
  [/^heads\//, (a, b) => ({ ...a, catalog: a.catalog ?? b.catalog, catalogSchema: a.catalogSchema ?? b.catalogSchema, v: maxMerge(a.v, b.v), offerings: maxMerge(a.offerings, b.offerings) })],
  [/^repIndex\//, (a, b) => ({ ...a, p: { ...b.p, ...a.p } })],
  [/^reviewIndex\//, (a, b) => ({ ...a, c: sumInto(a.c, b.c) })],
  [/^reviews\/[^/]+\/campus\//, (a, b) => ({ ...a, r: { ...b.r, ...a.r } })],
  [/^courses\/[^/]+\/stats\//, (a, b) => ({ ...a, count: a.count + b.count, starSum: a.starSum + b.starSum, recommendCount: a.recommendCount + b.recommendCount })],
  [/^resourceVersions\//, (a, b) => ({ ...a, v: Math.max(a.v ?? 0, b.v ?? 0), links: { ...b.links, ...a.links } })],
  [/^leaderboard\//, (a, b) => ({ ...a, p: { ...b.p, ...a.p }, tags: { ...b.tags, ...a.tags } })],
  [/^searchHints\//, (a, b) => ({ ...a, q: deepSum(a.q, b.q) })],
  [/^activity\//, (a, b) => ({ ...a, course: { ...b.course, ...a.course }, dept: { ...b.dept, ...a.dept } })],
  [/^pending\//, (a, b) => ({ ...a, batches: { ...b.batches, ...a.batches } })],
];

const profGroups = (docs) => {
  const g = new Map();
  for (const d of docs) {
    if (!d.path.startsWith('professors/') || d.data.removed || d.data.mergedInto || d.data.active === false) continue;
    const k = `${d.data.campus}|${d.data.department}`;
    (g.get(k) ?? g.set(k, []).get(k)).push(d.path.slice(11));
  }
  return g;
};

/** Points a synthetic set's professors at the existing ones of the same campus and department. */
export function remapProfessors(docs, existing) {
  const have = profGroups(existing);
  const mine = profGroups(docs);
  const map = new Map(), dropped = new Set();
  for (const [k, ids] of mine) {
    const target = have.get(k);
    if (!target) continue;
    ids.forEach((id, i) => map.set(id, target[i % target.length]));
    dropped.add(k);
  }
  if (!map.size) return docs;
  const swap = (v) => map.get(v) ?? v;
  const out = [];
  for (const d of docs) {
    let { path: p, data } = d;
    if (p.startsWith('professors/')) {
      if (dropped.has(`${data.campus}|${data.department}`)) continue; // that campus and department has real professors now
    } else if (/^reviews\/[^/]+\/entries\/[0-9a-f]{64}$/.test(p)) {
      data = { ...data, professorId: swap(data.professorId) };
    } else if (/^reviews\/[^/]+\/campus\//.test(p)) {
      data = { ...data, r: Object.fromEntries(Object.entries(data.r ?? {}).map(([k, e]) => [k, { ...e, professorId: swap(e.professorId) }])) };
    } else if (/^courses\/[^/]+\/stats\//.test(p) && data.professorId) {
      p = p.replace(/\/[^/]+$/, `/${data.campus}_${swap(data.professorId)}`);
      data = { ...data, professorId: swap(data.professorId) };
    } else if (/^courses\/[^/]+\/offerings\//.test(p) && Array.isArray(data.professors)) {
      data = { ...data, professors: data.professors.map(swap) };
    }
    out.push({ path: p, data });
  }
  return out;
}

export function combine(sets) {
  const out = new Map();
  const report = [];
  sets.forEach((set, i) => {
    let docs = set.docs;
    if (i > 0 && set.synthetic) docs = remapProfessors(docs, [...out.values()]);
    const hasCatalog = [...out.keys()].some((p) => p.startsWith('catalog/'));
    const ttCampuses = new Set([...out.keys()].filter((p) => /^timetable\/[^|]+\|current$/.test(p)).map((p) => p.slice(10).split('|')[0]));
    const r = { name: set.name, in: set.docs.length, added: 0, merged: 0, dropped: 0 };
    for (const d of docs) {
      const p = d.path;
      if (i > 0 && ((p.startsWith('catalog/') && hasCatalog) || (p.startsWith('timetable/') && ttCampuses.has(p.slice(10).split('|')[0])))) { r.dropped++; continue; }
      const had = out.get(p);
      if (!had) { out.set(p, d); r.added++; continue; }
      const m = MERGERS.find(([re]) => re.test(p));
      if (m) { out.set(p, { path: p, data: m[1](had.data, d.data) }); r.merged++; } else r.dropped++;
    }
    report.push(r);
  });
  const auth = new Map();
  for (const s of sets) for (const u of s.auth) if (!auth.has(u.uid) && ![...auth.values()].some(() => false)) auth.set(u.uid, u);
  return { docs: [...out.values()], auth: [...auth.values()], report };
}

export function loadSet(dir) {
  const mf = path.join(dir, 'manifest.json');
  const synthetic = existsSync(mf) && JSON.parse(readFileSync(mf, 'utf8')).synthetic === true;
  return { name: path.basename(dir), docs: readDocs(dir), auth: readAuth(dir), synthetic };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.out || a._.length < 2) { console.error('usage: combine.mjs --out <dir> <first> <second> [<third> …]   (the first wins on a collision)'); process.exit(2); }
  const r = combine(a._.map((d) => loadSet(path.resolve(d))));
  mkdirSync(path.resolve(a.out), { recursive: true });
  writeDocs(path.resolve(a.out), r.docs, r.auth);
  writeFileSync(path.join(path.resolve(a.out), 'manifest.json'), JSON.stringify({ combined: a._, docs: r.docs.length, auth: r.auth.length }, null, 1));
  for (const x of r.report) console.log(`${x.name}: ${x.in} docs: ${x.added} added, ${x.merged} merged into earlier ones, ${x.dropped} left out`);
  console.log(`Combined: ${r.docs.length} documents = ${r.docs.length} staging writes (${Math.ceil(r.docs.length / 18000)} day(s) at 18,000 a day), ${r.auth.length} auth users.`);
}
