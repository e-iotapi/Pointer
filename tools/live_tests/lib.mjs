// Shared by the live specs: where things are (local emulators or staging), tokens, the live socket, and
// the few Firestore writes the specs make as "another user".
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const MODE = process.env.LIVE_MODE ?? 'local';
export const LOCAL = MODE === 'local';
const ACCOUNTS = JSON.parse(readFileSync(new URL('../../test_env/accounts.json', import.meta.url), 'utf8'));
export const email = (key) => ACCOUNTS.accounts.find((a) => a.key === key).email;
export const PASSWORD = process.env.STAGING_PASSWORD ?? ACCOUNTS.password;

export const CFG = LOCAL
  ? {
      app: 'http://127.0.0.1:5050',
      worker: 'http://127.0.0.1:8793',
      auth: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com',
      fs: 'http://127.0.0.1:8085',
      project: 'demo-pointer',
      apiKey: 'x',
    }
  : {
      app: 'https://pointer-staging.web.app',
      worker: process.env.LIVE_WORKER_URL ?? 'https://pointer-heads-staging.siddhu-cms.workers.dev',
      auth: 'https://identitytoolkit.googleapis.com',
      fs: 'https://firestore.googleapis.com',
      project: 'pointer-staging',
      apiKey: 'AIzaSyD5aVnFDmzOQKjnuumyArZxFornqqrKHww', // lib/firebase_options_staging.dart (a public web key)
    };
export const WS = CFG.worker.replace(/^http/, 'ws');
// The origin the Worker's CORS list knows: the app's own.
export const ORIGIN = CFG.app;

export async function idToken(key) {
  const res = await fetch(`${CFG.auth}/v1/accounts:signInWithPassword?key=${CFG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email(key), password: PASSWORD, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`sign-in ${key}: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A live socket as the app opens it; frames are collected with arrival times. */
export function openLive(campus, token, { open = true } = {}) {
  const frames = [];
  const ws = new WebSocket(`${WS}/live/${campus}`, token ? ['pointer', token] : ['pointer']);
  const t0 = Date.now();
  const s = {
    ws,
    frames,
    closed: false,
    opened: new Promise((res, rej) => {
      ws.onopen = () => res(true);
      ws.onerror = () => rej(new Error('socket error / refused'));
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    /** Resolves with the first frame (already received or later) matching [pred]; null on timeout. */
    async waitFor(pred, ms = 8000, from = 0) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const f = frames.slice(from).find(pred);
        if (f) return f;
        await sleep(100);
      }
      return null;
    },
  };
  ws.onmessage = (e) => frames.push({ ...JSON.parse(e.data), at: Date.now() - t0 });
  ws.onclose = () => (s.closed = true);
  return s;
}

// ---- Firestore as "another user" -------------------------------------------------------------------------
// Local: the emulator's `owner` bearer bypasses the rules. Staging: the test owner's real ID token, so only
// what the rules allow (a head marker bump is allowed to any signed-in user).
let ownerAuth;
async function bearer() {
  if (LOCAL) return 'owner';
  return (ownerAuth ??= await idToken('owner'));
}
const doc = (p) => `projects/${CFG.project}/databases/(default)/documents/${p}`;

export async function commit(writes) {
  const res = await fetch(`${CFG.fs}/v1/${doc('')}:commit`.replace('documents/:commit', 'documents:commit'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`commit ${res.status}: ${await res.text()}`);
}

/** Moves marker [path] on [campuses]' heads, as bumpPath/bumpPathOnAllHeads do. */
export const bumpHeads = (campuses, path) =>
  commit(
    campuses.map((c) => ({
      transform: {
        document: doc(`heads/${c}`),
        fieldTransforms: [{ fieldPath: `v.\`${path}\``, increment: { integerValue: '1' } }],
      },
    })),
  );

export async function readHead(campus) {
  const res = await fetch(`${CFG.fs}/v1/${doc(`heads/${campus}`)}`, { headers: { Authorization: `Bearer ${await bearer()}` } });
  const f = (await res.json()).fields?.v?.mapValue?.fields ?? {};
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v.integerValue ?? 0)]));
}

export const str = (s) => ({ stringValue: s });
export const setFields = (path, fields) =>
  commit([{ update: { name: doc(path), fields }, updateMask: { fieldPaths: Object.keys(fields) } }]);
export const docName = doc;

/** First document of [coll] where [field] == [value], as {fields}. */
export async function firstWhere(coll, field, value) {
  const res = await fetch(`${CFG.fs}/v1/${doc('')}:runQuery`.replace('documents/:runQuery', 'documents:runQuery'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: str(value) } }, limit: 1 } }),
  });
  return (await res.json()).find((r) => r.document)?.document;
}

/** Creates [path] with [fields] (replacing any). */
export const putDoc = (path, fields) => commit([{ update: { name: doc(path), fields } }]);

/** CanvasKit from the build's own copy, so the run needs no internet (same as tools/e2e/specs/helpers.mjs). */
export async function installLocalCanvasKit(page) {
  const root = new URL('../../build/web/canvaskit/', import.meta.url);
  await page.route('https://www.gstatic.com/flutter-canvaskit/**', async (route) => {
    const rest = new URL(route.request().url()).pathname.split('/').filter(Boolean).slice(2).join('/');
    try {
      await route.fulfill({ status: 200, contentType: rest.endsWith('.wasm') ? 'application/wasm' : 'application/javascript', body: await readFile(new URL(rest, root)) });
    } catch {
      await route.continue();
    }
  });
}

/** Opens [route] signed in as [key] in its own browser context (the emulator build forgets sessions, so ?as= rides every load). */
export async function openAs(browser, key, route, ready) {
  const context = await browser.newContext({ baseURL: CFG.app });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${key}] pageerror`, e.message));
  if (process.env.LIVE_DEBUG) page.on('console', (m) => console.log(`[${key}] console`, m.text().slice(0, 300)));
  page.on('websocket', (w) => process.env.LIVE_DEBUG && (console.log(`[${key}] ws`, w.url()), w.on('framereceived', (f) => console.log(`[${key}] ws<-`, String(f.payload).slice(0, 200)))));
  await installLocalCanvasKit(page);
  await page.goto(`${route}?as=${key}`);
  const later = page.getByRole('button', { name: 'Not now' }); // the contributor nudge, shown once per open
  await later.first().waitFor({ timeout: 8000 }).then(() => later.first().click()).catch(() => {});
  await ready(page).waitFor({ timeout: 60_000 });
  return { context, page };
}

/** Increments a number field on a document (as the stores' version docs do). */
export const increment = (path, field) =>
  commit([{ transform: { document: doc(path), fieldTransforms: [{ fieldPath: field, increment: { integerValue: '1' } }] } }]);
