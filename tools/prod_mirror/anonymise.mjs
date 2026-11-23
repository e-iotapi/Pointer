#!/usr/bin/env node
// ANONYMISE: turns an export (export.mjs) into a production-shaped dataset
// with no personal data, and fails if anything personal survives.
//
//   node tools/prod_mirror/anonymise.mjs --in <export> --out <dir> --salt-file <path> [--shift-to-now | --shift-days N]
//
// --shift-to-now moves every timestamp so the newest past one is today: grants
// that were live at export time stay live (the rules compare expiresAt to the
// clock), and expired ones stay expired.
//
// Deterministic: the same salt gives the same fake identities on every run,
// and nothing derived from the output can be reversed without the salt.
// Keep the salt outside the repo (the owner holds it).
//
// Method: one traversal (`tx`) runs twice over every doc, once in collect
// mode (registers every email, uid, name, phone, username it meets, in ids,
// map keys and values alike) and once in apply mode (rewrites them). Maps are
// assigned in sorted order between the two, so the result does not depend on
// the order docs were read.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDir, parseArgs, readAuth, readDocs, sha256, writeDocs, root } from './lib.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const STUDENT = /^([fhp])(\d{4})(\d+)@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$/;
const BITS = /^[^@]+@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$/;
const TOKEN = /[A-Za-z0-9]{20,64}/g;
const PHONE = /(?<![\w.])\+?\d[\d ()-]{8,18}\d(?![\w])/g;
const TITLE = /^(dr|prof|mr|ms|mrs)\.?\s+/i;
const FIRST = 'Aarav Aditi Akash Ananya Arjun Bhavya Chirag Deepa Dev Diya Esha Farhan Gauri Harsh Isha Ishaan Jaya Kabir Kavya Kiran Lakshmi Manav Meera Mohan Naina Neel Nikhil Nisha Om Pooja Pranav Rahul Riya Rohan Saanvi Sahil Sana Samar Tanvi Tara Uday Varun Veda Vihaan Yash Zara Aman Anika Bharat Charu Dhruv Eshan Gita Hari Indu Jatin Kriti Leela Mira Nitin'.split(' ');
const LAST = 'Agarwal Bansal Bhatt Chopra Das Desai Dutta Gill Goyal Gupta Iyer Jain Joshi Kapoor Khan Kohli Kulkarni Mehta Menon Mishra Nair Pandey Patel Pillai Rao Reddy Saxena Sethi Shah Sharma Shetty Singh Sinha Soni Tiwari Trivedi Varma Verma Yadav Zaveri Arora Banerjee Bose Chandra Dixit Ghosh Hegde Kamat Lal Malhotra Naidu Oberoi Prasad Rastogi Sen Thakur Upadhyay Venkat Wagle Xavier Yogi Zutshi'.split(' ');
const WORDS = 'the course was really helpful and clear with good notes tutorials quiz paper exam lecture lab project grading fair easy hard heavy light interesting practical theory examples slides doubts doubt office hours attendance marks scheme midsem compre average relative topics syllabus covered pace slow fast engaging boring recommended avoid notes drive folder resource link sheet solved previous year papers problems concepts basics advanced'.split(' ');

// Words that are ordinary language or course vocabulary: a one-word "name" made of them is not a person.
const COMMON = new Set([...WORDS, ...'profile admin owner test tester user student students teacher staff faculty president secretary actual expected third fourth fifth quiz assignment assignments lab labs midsem compre project tutorial lecture course courses new old none all null true false the and for with from this that department dept campus goa pilani hyderabad dubai role custom support pointer team sir madam mr ms mrs dr prof'.split(' '),
  ...(() => { try { return readFileSync(path.join(root, 'assets', 'catalog.json'), 'utf8').match(/[A-Za-z]{3,}/g).map((w) => w.toLowerCase()); } catch { return []; } })()]);
/** A normalised name that is worth hunting for in free text: not made only of common words; one word needs 4+ letters. */
const eligible = (base) => {
  const t = base.split(' ');
  return t.length === 1 ? t[0].length >= 4 && !COMMON.has(t[0]) : t.some((x) => !COMMON.has(x));
};
/** A given name or surname worth hunting on its own: 3+ letters, not an ordinary word. */
const isPart = (t) => t.length >= 3 && /[a-z]/.test(t) && !COMMON.has(t);
/** Digits of a phone-like match, or null when it is an epoch, a long id or too short/long to be a phone. */
const phoneDigits = (m) => {
  const d = m.replace(/\D/g, '');
  if (d.length < 10 || d.length > 13) return null;
  if (/^\d+$/.test(m) && d[0] === '1' && (d.length === 10 || d.length === 13)) return null; // epoch seconds / ms; Indian mobiles start 6-9
  return d;
};
const matchCase = (orig, fake) => (orig[0] === orig[0].toUpperCase() ? fake[0].toUpperCase() + fake.slice(1) : fake);
const hm = (salt, s) => createHmac('sha256', salt).update(s).digest('hex');
const normName = (s) => s.toLowerCase().replace(TITLE, '').replace(/[^a-z0-9]+/g, ' ').trim();
const windows = (words, max = 5) => {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= max && i + n <= words.length; n++) out.push(words.slice(i, i + n).join(' '));
  }
  return out;
};
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const base62 = (hex, len) => {
  let out = '', i = 0;
  while (out.length < len) { out += B62[parseInt(hex.slice(i, i + 2), 16) % 62]; i = (i + 2) % 62; }
  return out;
};

const NAME_KEYS = new Set(['name', 'displayName', 'contactName', 'fullName', 'hiddenByName']);
const ACTOR_KEYS = new Set(['actor', 'by', 'grantedBy', 'addedBy', 'updatedBy', 'removedBy', 'closedBy', 'decidedBy', 'hiddenBy', 'revokedBy', 'handedOverBy']);
const PHONE_KEYS = new Set(['phone', 'whatsapp', 'mobile', 'contactTarget']);
const TEXT_KEYS = new Set(['text', 'note', 'message', 'comment', 'details', 'feedback', 'body', 'description']);
const RESOURCE_COLLS = new Set(['resources', 'resourceVersions', 'pending', 'resourceReports', 'resourceFlags']);
const SAFE_PROFILE = new Set(['Actual', 'Expected', 'Third', 'Fourth', 'Fifth']);

/** The pieces of a dataset that are about people. Built by collect mode. */
class Registry {
  emails = new Set(); uids = new Set(); names = new Set(); phones = new Set();
  usernames = new Set(); parts = new Set(); hints = new Set(); hashes = new Set(); pairs = new Map(); grades = [];
}

/** Seconds from the newest past timestamp to now: shifting by it makes the export "today". */
export function shiftToNowSeconds(docs, now = Math.floor(Date.now() / 1000)) {
  let max = 0;
  // Expiry times say nothing about when the export was taken.
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.__t === 'ts') { if (v.s <= now && v.s > max) max = v.s; return; }
      if (v.__t) return;
      for (const [k, x] of Object.entries(v)) if (k !== 'expiresAt' && k !== 'until') walk(x);
    }
  };
  for (const d of docs) walk(d.data);
  return max ? now - max : 0;
}

export function anonymise(docs, auth, { salt, shiftDays = 0, shiftSeconds }) {
  if (!salt || salt.length < 16) throw new Error('The salt must be at least 16 characters.');
  const R = new Registry();
  const shiftSec = shiftSeconds ?? Math.round(shiftDays * 86400);

  // ---- maps, filled between the two passes ----
  const M = { part: new Map(), email: new Map(), uid: new Map(), name: new Map(), phone: new Map(), user: new Map(), hash: new Map(), emailName: new Map() };
  let collecting = true;
  let lorem = WORDS;

  const fakeEmails = new Set(), fakePhones = new Set(), fakeNames = new Set();
  let origNames = new Set();

  // ---- mappers: in collect mode they register, in apply mode they rewrite ----
  const mapEmail = (e) => {
    const l = e.toLowerCase();
    if (collecting) { R.emails.add(l); return e; }
    return M.email.get(l) ?? l;
  };
  const mapName = (s, email) => {
    if (s === '') return s;
    const base = normName(s);
    if (collecting) {
      R.names.add(base);
      for (const t of base.split(' ')) if (t.length >= 3 && /[a-z]/.test(t)) R.parts.add(t);
      if (email) (R.pairs.get(email.toLowerCase()) ?? R.pairs.set(email.toLowerCase(), new Set()).get(email.toLowerCase())).add(base);
      return s;
    }
    const title = TITLE.exec(s.trim())?.[0].trim() ?? '';
    const fake = (email && M.emailName.get(email.toLowerCase())) || M.name.get(base) || 'Anon Person';
    return title ? `${title} ${fake}` : fake;
  };
  const mapPhone = (p) => {
    if (collecting) { R.phones.add(p.replace(/\D/g, '')); return p; }
    return M.phone.get(p) ?? p.replace(/\d/g, '0');
  };
  const mapUser = (u) => {
    if (collecting) { R.usernames.add(u); return u; }
    return M.user.get(u) ?? u;
  };
  const textLike = (s, key) => {
    if (collecting) return s;
    const h = hm(salt, 'text:' + s);
    const n = Math.max(1, Math.min(80, Math.round(s.length / 6)));
    const w = [];
    for (let i = 0; i < n; i++) w.push(lorem[parseInt(h.slice((i * 3) % 60, ((i * 3) % 60) + 3), 16) % lorem.length]);
    const out = w.join(' ');
    return out.charAt(0).toUpperCase() + out.slice(1);
  };

  /** Names of known people inside free text (audit actions, snapshots): the longest window first. */
  const scrubNames = (str) => {
    const toks = [...str.matchAll(/[A-Za-z0-9]+/g)];
    let out = '', at = 0;
    for (let i = 0; i < toks.length; i++) {
      for (let n = Math.min(5, toks.length - i); n >= 1; n--) {
        const key = toks.slice(i, i + n).map((t) => t[0].toLowerCase()).join(' ');
        const fake = (eligible(key) && M.name.get(key)) || (n === 1 && M.part.get(key) && matchCase(toks[i][0], M.part.get(key)));
        if (fake) {
          const last = toks[i + n - 1];
          out += str.slice(at, toks[i].index) + fake;
          at = last.index + last[0].length;
          i += n - 1;
          break;
        }
      }
    }
    return at ? out + str.slice(at) : str;
  };

  /** Every personal pattern inside a free string: emails, uids/hashes, phones. */
  const scrub = (s) => {
    if (s.length < 5) return s;
    let r = s;
    if (r.includes('@')) r = r.replace(EMAIL, (e) => mapEmail(e));
    if (r.length >= 20) {
      r = r.replace(TOKEN, (t) => {
        if (collecting) return t;
        return M.uid.get(t) ?? M.hash.get(t) ?? t;
      });
    }
    if (/\d{7}/.test(r.replace(/\d{4}-\d{2}-\d{2}/g, ''))) {
      r = r.replace(PHONE, (p) => {
        const digits = phoneDigits(p);
        if (!digits || /^\d{4}-\d{2}-\d{2}/.test(p) || fakePhones.has(digits)) return p;
        return mapPhone(p);
      });
    }
    if (!collecting && /[A-Za-z]{4}/.test(r)) r = scrubNames(r);
    return r;
  };

  const txUsersData = (s, uid) => {
    let j;
    try { j = JSON.parse(s); } catch { return scrub(s); }
    const rnd = (label) => parseInt(hm(salt, `${uid}:${label}`).slice(0, 8), 16) / 0xffffffff;
    const pickGrade = (label, orig) => {
      if (typeof orig !== 'number' || orig <= 0) return orig; // sentinels (ungraded, withdrawn) stay
      if (collecting) { R.grades.push(orig); return orig; }
      const pool = M.gradePool;
      return pool.length ? pool[Math.floor(rnd(label) * pool.length)] : orig;
    };
    const walk = (v, ctx) => {
      if (typeof v === 'string') return scrub(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, ctx));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), walk(x, ctx)]));
      return v;
    };
    for (const box of ['coursesBox', 'offshootBox']) {
      if (!Array.isArray(j[box])) continue;
      j[box] = j[box].map(([k, c]) => {
        if (!c || typeof c !== 'object') return [scrub(String(k)), walk(c)];
        const o = { ...c };
        for (const f of ['grade1', 'grade2']) if (f in o) o[f] = pickGrade(`${box}:${k}:${f}`, o[f]);
        if (o.more && typeof o.more === 'object') {
          o.more = Object.fromEntries(Object.entries(o.more).map(([pk, g]) => [pk, pickGrade(`${box}:${k}:more${pk}`, g)]));
        }
        return [typeof k === 'string' ? scrub(k) : k, walk(o)];
      });
    }
    if (Array.isArray(j.marksBox)) {
      j.marksBox = j.marksBox.map(([k, v]) => {
        if (!v || typeof v !== 'object') return [k, walk(v)];
        const o = { ...v };
        if (o.t === 'eval' && Array.isArray(o.p)) {
          o.p = o.p.map((p, i) => {
            const q = { ...p };
            if (typeof q.m === 'number' && typeof q.o === 'number') q.m = Math.round(q.o * (0.35 + 0.6 * rnd(`${k}:${i}:m`)) * 2) / 2;
            if (typeof q.a === 'number' && typeof q.o === 'number') q.a = Math.round(q.o * (0.4 + 0.3 * rnd(`${k}:${i}:a`)) * 2) / 2;
            return q;
          });
          if (typeof o.a === 'number') o.a = Math.round(o.a * (0.8 + 0.4 * rnd(`${k}:a`)) * 10) / 10;
        }
        if (o.t === 'config' && typeof o.a === 'number') o.a = Math.round(o.a * (0.8 + 0.4 * rnd(`${k}:ca`)) * 10) / 10;
        return [typeof k === 'string' ? scrub(k) : k, walk(o)];
      });
    }
    if (Array.isArray(j.settingsBox)) {
      j.settingsBox = j.settingsBox.map(([k, v]) => {
        if (typeof v === 'string' && /^profile\d*n$/.test(k) && !SAFE_PROFILE.has(v)) return [k, `Profile ${k.replace(/\D/g, '') || 1}`];
        return [k, walk(v)];
      });
    }
    for (const box of Object.keys(j)) {
      if (!['coursesBox', 'offshootBox', 'marksBox', 'settingsBox'].includes(box)) j[box] = walk(j[box]);
    }
    return JSON.stringify(j);
  };

  // ---- the traversal ----
  const tx = (v, key, c, parent) => {
    if (typeof v === 'string') return txString(v, key, c, parent);
    if (Array.isArray(v)) return v.map((x) => tx(x, key, c, parent));
    if (v && typeof v === 'object') {
      if (v.__t === 'ts') return shiftSec && !collecting ? { ...v, s: v.s + shiftSec } : v;
      if (v.__t) return v;
      const child = { ...c, keys: [...c.keys, key] };
      const out = {};
      for (const [k, x] of Object.entries(v)) out[txKey(k, child)] = tx(x, k, child, v);
      return out;
    }
    return v;
  };

  const txKey = (k, c) => {
    const parentKey = c.keys.at(-1);
    if (c.coll === 'leaderboard' && (parentKey === 'p' || parentKey === 'tags')) return mapUser(k);
    if (c.coll === 'searchHints') return hintWords(k);
    return scrub(k);
  };
  // searchHints keys are lowercase words people searched; map word by word.
  const hintWords = (s) => (collecting ? (s.split(' ').forEach((w) => w.length > 1 && R.hints.add(w)), s)
    : s.split(' ').map((w) => (w.length > 1 && !/\d/.test(w) ? lorem[parseInt(hm(salt, 'hint:' + w).slice(0, 6), 16) % lorem.length] : w)).join(' '));

  const txString = (s, key, c, parent) => {
    if (c.coll === 'users' && key === 'data' && c.keys.length === 1) return txUsersData(s, c.selfUid);
    if (c.coll === 'users' && key === 'v1' && c.keys.length === 1) return txUsersData(s, c.selfUid);
    if (c.coll === 'searchHints' && (key === 'k' || key === 't')) return hintWords(s);
    if (c.coll === 'leaderboard' && key === 'k' && c.keys.length === 1) return mapUser(s);
    if (NAME_KEYS.has(key)) {
      const actor = ACTOR_KEYS.has(c.keys.at(-1));
      const pk = c.keys.at(-1);
      const email = typeof parent?.email === 'string' ? parent.email : pk?.includes('@') ? pk : c.selfEmail;
      if (key !== 'name' || email || actor || c.coll === 'professors') return mapName(s, email);
    }
    if ((key === 'aliases' || key === 'prof') && (c.coll === 'professors' || c.coll === 'timetable')) return mapName(s);
    if (c.coll === 'professors' && key === 'name') return mapName(s);
    if (PHONE_KEYS.has(key) && /\d/.test(s) && !s.includes('@')) return mapPhone(s);
    if (key === 'username' || key === 'activeUsername') return mapUser(s);
    if (c.coll === 'audit' && key === 'summary') return typeof parent?.action === 'string' ? scrub(parent.action) : textLike(s, key);
    if (TEXT_KEYS.has(key) || (key === 'title' && RESOURCE_COLLS.has(c.coll))) return textLike(s, key);
    if (key === 'reason' && !/^[a-z][a-z_-]{1,24}$/.test(s)) return textLike(s, key);
    if (key === 'url' && /^https?:\/\//.test(s)) {
      if (collecting) return s;
      const m = /^(https?:\/\/[^/?#]+)/.exec(s);
      return `${m[1]}/x${hm(salt, 'url:' + s).slice(0, 10)}`; // x: never a run of digits a phone scan could take
    }
    return scrub(s);
  };

  const emailInPath = (p) => p.match(EMAIL)?.[0]?.toLowerCase();
  const txPath = (p, coll) => {
    const segs = p.split('/').map((seg, i) => {
      if (coll === 'usernames' && i === 1) {
        const [campus, ...u] = seg.split('|');
        return [campus, mapUser(u.join('|'))].join('|');
      }
      return scrub(seg);
    });
    return segs.join('/');
  };

  const run = () => docs.map((d) => {
    const coll = d.path.split('/')[0];
    const ctx = { coll, keys: [], selfEmail: emailInPath(d.path) ?? (coll === 'audit' && typeof d.data?.path === 'string' && /^(grants|staff|people|directory|owners|staffContacts|contributors|contributorRequests|volunteers)\//.test(d.data.path) ? emailInPath(d.data.path) : undefined), selfUid: coll === 'users' ? d.path.split('/')[1] : '' };
    return { path: txPath(d.path, coll), data: tx(d.data, '', ctx, null) };
  });

  // ---- pass 1: collect ----
  for (const u of auth) {
    if (u.uid) R.uids.add(u.uid);
    if (u.email) mapEmail(u.email);
    if (u.displayName) mapName(u.displayName, u.email);
  }
  for (const d of docs) {
    const parts = d.path.split('/');
    if (parts[0] === 'users') R.uids.add(parts[1]);
    // uid fields
    const uidField = d.data?.uid;
    if (typeof uidField === 'string') R.uids.add(uidField);
  }
  // Hashed ids found in paths (reviews, votes, reports) are original ids too.
  for (const d of docs) for (const t of d.path.match(/[0-9a-f]{64}/g) ?? []) R.hashes.add(t);
  run();
  collecting = false;

  // ---- assign ----
  const emails = [...R.emails].sort();
  for (const k of R.names) origNames.add(k);
  const nameClash = (cand) => {
    const t = normName(cand).split(' ');
    return windows(t).some((w) => origNames.has(w)) || t.some((x) => R.parts.has(x));
  };
  const SYL = 'ba be bi bo bu da de di do ka ke ki ko la le li lo ma me mi mo na ne ni no ra re ri ro sa se si so ta te ti to va ve vi vo za ze zi zo'.split(' ');
  const syl = (h, k) => Array.from({ length: 3 }, (_, i) => SYL[parseInt(h.slice(k + i * 2, k + i * 2 + 2), 16) % SYL.length]).join('');
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const mkName = (label) => {
    for (let n = 0; ; n++) {
      const h = hm(salt, `name:${label}:${n}`);
      // the lists first; when real names have used them up, invented syllables
      const cand = n < 30 ? `${FIRST[parseInt(h.slice(0, 6), 16) % FIRST.length]} ${LAST[parseInt(h.slice(6, 12), 16) % LAST.length]}` : `${cap(syl(h, 0))} ${cap(syl(h, 8))}`;
      if (!nameClash(cand)) return cand;
    }
  };
  for (const e of emails) {
    let fake;
    for (let n = 0; ; n++) {
      const h = hm(salt, `email:${e}:${n}`);
      const m = STUDENT.exec(e);
      if (m) {
        const [, l, year, rest, campus] = m;
        const serial = (BigInt('0x' + h.slice(0, 14)) % 10n ** BigInt(rest.length)).toString().padStart(rest.length, '0');
        fake = `${l}${year}${serial}@${campus}.bits-pilani.ac.in`;
      } else if (BITS.test(e)) {
        fake = `u${h.slice(0, 8)}@${e.split('@')[1]}`;
      } else {
        fake = `u${h.slice(0, 8)}@example.com`;
      }
      if (!R.emails.has(fake) && !fakeEmails.has(fake)) break;
    }
    fakeEmails.add(fake);
    M.email.set(e, fake);
    M.emailName.set(e, mkName(e));
  }
  for (const e of emails) {
    for (const b of R.pairs.get(e) ?? []) if (!M.name.has(b)) M.name.set(b, M.emailName.get(e));
  }
  for (const b of [...R.names].sort()) if (!M.name.has(b)) M.name.set(b, mkName(b));
  for (const x of M.name.values()) fakeNames.add(x);
  // a given name or surname seen alone in free text maps to the same position of the fake name
  for (const b of [...R.names].sort()) {
    const ft = M.name.get(b).toLowerCase().split(' ');
    b.split(' ').forEach((t, i) => { if (isPart(t) && !M.part.has(t)) M.part.set(t, ft[Math.min(i, ft.length - 1)]); });
  }
  lorem = WORDS.filter((w) => !origNames.has(w) && !R.parts.has(w));
  for (const u of [...R.uids].sort()) {
    for (let n = 0; ; n++) {
      const f = base62(hm(salt, `uid:${u}:${n}`), Math.max(20, u.length));
      if (!R.uids.has(f)) { M.uid.set(u, f); break; }
    }
  }
  const phoneKeys = new Map();
  for (const p of [...R.phones].sort()) {
    const h = hm(salt, 'phone:' + p);
    let i = 0;
    let f = p.replace(/\d/g, () => String(parseInt(h[i++ % 64], 16) % 10));
    if (f === p) f = p.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
    // keep a plausible mobile prefix
    f = f.length >= 10 ? f.replace(/^(\D*)\d/, (_, a) => a + '9') : f;
    phoneKeys.set(p, f);
  }
  const phoneFor = (raw) => {
    const digits = raw.replace(/\D/g, '');
    const base = phoneKeys.get(digits) ?? digits;
    let i = 0;
    const out = raw.replace(/\d/g, () => base[i++] ?? '0');
    fakePhones.add(out.replace(/\D/g, ''));
    return out;
  };
  M.phone = { get: phoneFor };
  const unames = [...R.usernames].sort();
  const usedU = new Set(unames);
  for (const u of unames) {
    for (let n = 0; ; n++) {
      const f = `u_${hm(salt, `user:${u}:${n}`).slice(0, 7)}`;
      if (!usedU.has(f)) { usedU.add(f); M.user.set(u, f); break; }
    }
  }
  M.gradePool = R.grades.length ? R.grades.slice().sort((a, b) => a - b) : [];

  // ---- hashed ids: recompute so the mapped person still owns their rows ----
  resolveHashes(docs, R, M, salt);

  // ---- pass 2: apply ----
  const out = run();
  // nameTokens are prefixes of the name words (tools/test_env/seed.mjs): rebuild
  // them from the fake name and aliases, or the old name survives in them.
  for (const d of out) {
    if (!d.path.startsWith('professors/') || !Array.isArray(d.data.nameTokens)) continue;
    const titles = new Set(['dr', 'prof', 'mr', 'ms', 'mrs']);
    const tokens = new Set();
    for (const n of [d.data.name, ...(d.data.aliases ?? [])]) {
      for (const w of String(n).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x && !titles.has(x))) {
        for (let i = 1; i <= Math.min(w.length, 12); i++) tokens.add(w.slice(0, i));
      }
    }
    d.data.nameTokens = [...tokens];
  }
  const authOut = auth.map((u) => ({
    uid: M.uid.get(u.uid) ?? u.uid,
    email: u.email ? M.email.get(u.email.toLowerCase()) : null,
    displayName: u.displayName ? mapName(u.displayName, u.email) : null,
    disabled: u.disabled ?? false,
  }));
  for (const u of authOut) if (u.email) fakeEmails.add(u.email);
  return { docs: out, auth: authOut, registry: R, fakes: { emails: fakeEmails, phones: fakePhones, names: fakeNames }, maps: M };
}

/** reviews: sha256(uid+course); votes/reports: sha256(uid+reviewId); resource reports: sha256(uid+resourceId). */
function resolveHashes(docs, R, M, salt) {
  const uids = [...R.uids].sort();
  const fallback = (id) => sha256(`${salt}|h|${id}`);
  const groupBy = (re) => {
    const m = new Map();
    for (const d of docs) {
      const x = re.exec(d.path);
      if (x) (m.get(x[1]) ?? m.set(x[1], new Set()).get(x[1])).add(x[2]);
    }
    return m;
  };
  const resolve = (groups) => {
    for (const [key, ids] of groups) {
      const left = new Set(ids);
      for (const u of uids) {
        const h = sha256(u + key);
        if (left.has(h)) {
          // a vote's key is the review id: map it to the NEW review id
          M.hash.set(h, sha256(M.uid.get(u) + (M.hash.get(key) ?? key)));
          left.delete(h);
          if (!left.size) break;
        }
      }
      for (const h of left) M.hash.set(h, fallback(h));
    }
  };
  resolve(groupBy(/^reviews\/([^/]+)\/entries\/([0-9a-f]{64})$/));
  resolve(groupBy(/^reviews\/[^/]+\/entries\/([^/]+)\/(?:votes|reports)\/([0-9a-f]{64})$/));
  resolve(groupBy(/^resourceReports\/([^/]+)\/entries\/([0-9a-f]{64})$/));
}

// ---- the leak check -------------------------------------------------------

const plainKey = (k) => /^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(k);

/** Every string of a doc with where it sits: an id segment, a map key or a value, and its field path. */
function* itemsOf(doc) {
  const segs = doc.path.split('/');
  for (let i = 0; i < segs.length; i++) yield { where: 'id', field: `id[${i}]`, s: segs[i] };
  function* walk(v, field) {
    if (typeof v === 'string') { yield { where: 'value', field, s: v }; return; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* walk(v[i], `${field}[${i}]`); return; }
    if (v && typeof v === 'object' && !v.__t) {
      for (const [k, x] of Object.entries(v)) {
        const f = `${field ? field + '.' : ''}${plainKey(k) ? k : '<key>'}`;
        yield { where: 'key', field: f, s: k };
        yield* walk(x, f);
      }
    }
  }
  yield* walk(doc.data, '');
}

/**
 * Fails on any original email/name/phone/uid/username, and on any email-like or
 * phone-like string that is not a fake. Each finding says what, in which
 * collection and field, and whether in an id, a key or a value: never the text.
 */
export function leakCheck(outDocs, outAuth, R, fakes) {
  const problems = [];
  const phones10 = new Set([...R.phones].map((d) => d.slice(-10)));
  const one = (p, it, kind, extra = {}) => problems.push({ path: p, kind, collection: p.split('/')[0], field: it.field, where: it.where, ...extra });
  const check = (p, items) => {
    for (const it of items) {
      const s = it.s;
      if (s.length < 4) continue;
      if (s.includes('@')) {
        for (const m of s.matchAll(EMAIL)) {
          const e = m[0].toLowerCase();
          if (R.emails.has(e)) one(p, it, 'email');
          else if (!fakes.emails.has(e)) one(p, it, 'unknown-email');
        }
      }
      if (s.length >= 20) for (const t of s.matchAll(TOKEN)) if (R.uids.has(t[0]) || R.hashes.has(t[0])) one(p, it, 'uid-or-hash', { tokenLength: t[0].length, isUid: R.uids.has(t[0]) });
      const stripped = s.replace(EMAIL, ' ').replace(/[0-9a-fA-F]{32,}/g, ' ').replace(/\d{4}-\d{2}-\d{2}/g, ' ');
      if (/\d{9}/.test(stripped)) {
        for (const m of stripped.matchAll(PHONE)) {
          const d = phoneDigits(m[0]);
          if (!d) continue;
          if (phones10.has(d.slice(-10))) one(p, it, 'phone');
          else if (!fakes.phones.has(d)) one(p, it, 'unknown-phone', { digits: d.length, separators: /\D/.test(m[0]) });
        }
      }
      if (R.usernames.has(s) || s.split('|').some((x) => R.usernames.has(x))) one(p, it, 'username');
      const words = normName(s).split(' ');
      if (words.length && words.length < 400) {
        for (let i = 0; i < words.length; i++) {
          let hit = false;
          for (let n = 1; n <= 5 && i + n <= words.length && !hit; n++) {
            const w = words.slice(i, i + n).join(' ');
            if ((w.length >= 4 && R.names.has(w) && eligible(w)) || (n === 1 && R.parts.has(w) && !COMMON.has(w))) { one(p, it, 'name', { window: n, common: w.split(' ').every((x) => COMMON.has(x)) }); hit = true; }
          }
          if (hit) break;
        }
      }
    }
  };
  for (const d of outDocs) check(d.path, itemsOf(d));
  for (const u of outAuth) check(`auth:${u.uid}`, [u.uid, u.email ?? '', u.displayName ?? ''].map((s, i) => ({ where: 'value', field: ['uid', 'email', 'displayName'][i], s })));
  return problems;
}

/** kind x collection x field (indexes folded) -> count, most frequent first. */
export function leakTable(problems) {
  const t = new Map();
  for (const p of problems) {
    const k = [p.kind, p.collection, p.where, p.field.replace(/\[\d+\]/g, '[]')].join(' | ');
    t.set(k, (t.get(k) ?? 0) + 1);
  }
  return [...t].sort((a, b) => b[1] - a[1]);
}

export function summarise(problems) {
  const by = {};
  for (const p of problems) by[p.kind] = (by[p.kind] ?? 0) + 1;
  return by;
}

function main() {
  const a = parseArgs(process.argv.slice(2), ['shift-to-now']);
  if (!a.in || !a.out || !a['salt-file']) {
    console.error('usage: anonymise.mjs --in <export> --out <dir> --salt-file <path> [--shift-to-now | --shift-days N] [--accept-unknown unknown-phone] [--leak-report <file>]');
    process.exit(2);
  }
  assertSafeDir(a['salt-file'], 'The salt file');
  const inDir = assertSafeDir(a.in, 'The export');
  const outDir = assertSafeDir(a.out, 'The output');
  const salt = readFileSync(a['salt-file'], 'utf8').trim();
  const docs = readDocs(inDir), auth = readAuth(inDir);
  console.log(`Read ${docs.length} documents, ${auth.length} auth users.`);
  const res = anonymise(docs, auth, { salt, shiftDays: Number(a['shift-days'] ?? 0), shiftSeconds: a['shift-to-now'] ? shiftToNowSeconds(docs) : undefined });
  const all = leakCheck(res.docs, res.auth, res.registry, res.fakes);
  // Only the two "looks like, but is not any known value" kinds can be waved through: a doc id of digits, say.
  const soft = new Set((a['accept-unknown'] ?? '').split(',').filter((k) => ['unknown-phone', 'unknown-email'].includes(k)));
  const problems = all.filter((p) => !soft.has(p.kind));
  if (all.length > problems.length) console.warn(`Accepted ${all.length - problems.length} ${[...soft].join('/')} findings (--accept-unknown). Look at them yourself.`);
  if (a['leak-report']) {
    // No values, no matched text: kind, collection, where (id/key/value), field path, window size.
    writeFileSync(a['leak-report'], JSON.stringify({ total: all.length, table: leakTable(all).map(([k, n]) => ({ at: k, count: n })),
      findings: all.map(({ path: _p, ...rest }) => rest) }, null, 1));
    console.error(`Leak report: ${a['leak-report']}`);
  }
  if (all.length) {
    console.error('kind | collection | where | field -> count');
    for (const [k, n] of leakTable(all).slice(0, 40)) console.error(`  ${String(n).padStart(5)}  ${k}`);
  }
  if (problems.length) {
    console.error(`LEAK CHECK FAILED: ${problems.length} findings ${JSON.stringify(summarise(problems))}. Nothing written. First paths:`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p.kind}: ${p.path}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  writeDocs(outDir, res.docs, res.auth);
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ anonymised: true, docs: res.docs.length, auth: res.auth.length }, null, 1));
  console.log(`Leak check passed. Wrote ${res.docs.length} documents and ${res.auth.length} auth users to ${outDir}.`);
  console.log(`Identities: ${res.registry.emails.size} emails, ${res.registry.uids.size} uids, ${res.registry.names.size} names, ${res.registry.phones.size} phones, ${res.registry.usernames.size} usernames.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
