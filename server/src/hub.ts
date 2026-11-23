import { DurableObject } from "cloudflare:workers";
import { readDoc, type Env } from "./firestore";

type Versions = Record<string, number>;

const HEAD_TTL_MS = 60_000;
const ALARM_DELAY_MS = 1_500;
const MIN_READ_GAP_MS = 20_000;
const RETRY_MS = 5_000;
const POKE_ME_GAP_MS = 2_000;
const MAX_FRAME = 1024;
const MAX_RETRIES = 3;
const FANOUT_GAP_MS = 1_000; // per socket: pokes that reach other campuses' hubs
const USER_GAP_MS = 250; // per socket: pokeUser frames
const USER_POKES_PER_HOUR = 30; // per sender: pokeUser frames (an appointer does a few an hour; a stranger's cost is capped)
const MAX_SENDERS = 512;

export const CAMPUSES = ["goa", "hyderabad", "pilani", "dubai"];
const campusHub = (env: Env, campus: string) => env.HUB.get(env.HUB.idFromName(campus)) as unknown as CampusHub;

/** Paths in `next` whose version differs from `prev` (new paths count as moved). */
export function diffVersions(prev: Versions, next: Versions): Versions {
  const out: Versions = {};
  for (const [k, v] of Object.entries(next)) if (prev[k] !== v) out[k] = v;
  return out;
}

const numbers = (m: unknown, prefix = ""): [string, number][] =>
  m && typeof m === "object"
    ? Object.entries(m)
        .filter(([, n]) => typeof n === "number")
        .map(([k, n]) => [prefix + k, n as number])
    : [];

/** A 31-bit hash of `x`'s JSON, so a change to a head field that is not a counter still moves a number. */
const hashOf = (x: unknown): number => {
  let h = 0;
  for (const ch of JSON.stringify(x)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h & 0x7fffffff;
};

/**
 * The head doc's `v` map (marker path -> version), its scheme versions as
 * `o:<course|term>` (owner, 2026-10-06), and a hash of the public contact as `#contact` (BRK-014), numbers only;
 * other head fields never leave.
 */
export const markers = (d: Record<string, unknown> | null): Versions =>
  Object.fromEntries([
    ...numbers(d?.v),
    ...numbers(d?.offerings, "o:"),
    ...(d?.contact && typeof d.contact === "object" ? [["#contact", hashOf(d.contact)] as [string, number]] : []),
  ]);

export class CampusHub extends DurableObject<Env> {
  private cache: { head: Versions; at: number } | null = null;
  private last: Versions | null = null; // what clients were last told
  private armed = false; // an alarm is pending (in memory; re-checked via getAlarm after hibernation)
  private lastReadAt = 0;
  private retries = 0;
  private pokeMeAt = new WeakMap<WebSocket, number>(); // socket (device) -> last admitted pokeMe; resets on hibernation
  private fanoutAt = new WeakMap<WebSocket, number>(); // socket -> last poke it fanned out to other hubs
  private userAt = new WeakMap<WebSocket, number>(); // socket -> last pokeUser admitted
  private sent = new Map<string, { from: number; n: number }>(); // sender uid -> pokeUser count this hour

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)");
    // How many times each person's roles were announced (every hub counts them: pokeUser reaches all four).
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS roles (email TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)");
  }

  async fetch(req: Request): Promise<Response> {
    const campus = new URL(req.url).pathname.split("/").pop()!;
    const uid = req.headers.get("X-Uid");
    if (!uid || req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    const email = req.headers.get("X-Email")?.toLowerCase();
    this.ctx.acceptWebSocket(server, email ? [uid, `e:${email}`] : [uid]);
    await this.sendHello(server, uid, campus);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "pointer" } });
  }

  async sendHello(ws: WebSocket, uid: string, campus: string): Promise<void> {
    if ((await this.ctx.storage.get<string>("campus")) !== campus) await this.ctx.storage.put("campus", campus);
    let head: Versions;
    let good: Versions | null = null; // a head that really came from Firestore
    const now = Date.now();
    if (this.cache && now - this.cache.at < HEAD_TTL_MS) head = good = this.cache.head;
    else {
      try {
        head = good = markers(await readDoc(`heads/${campus}`, this.env));
        this.cache = { head, at: now };
      } catch {
        head = {}; // the cache here is older than HEAD_TTL_MS: better nothing than a number that may be behind
      }
    }
    this.last ??= (await this.ctx.storage.get<Versions>("last")) ?? good;
    const email = this.ctx.getTags(ws).find((t) => t.startsWith("e:"))?.slice(2);
    ws.send(JSON.stringify({ t: "hello", head, me: this.me(uid), roles: email ? this.rolesV(email) : 0 }));
  }

  private rolesV(email: string): number {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM roles WHERE email = ?", email).toArray();
    return rows.length ? Number(rows[0].v) : 0;
  }

  /** Called by a poked hub (any campus): count the change and tell the person's sockets here. */
  async notifyUser(email: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO roles (email, v) VALUES (?, 1) ON CONFLICT(email) DO UPDATE SET v = v + 1", email);
    const out = JSON.stringify({ t: "roles", v: this.rolesV(email) });
    for (const s of this.ctx.getWebSockets(`e:${email}`)) s.send(out);
  }

  /** A write moved this campus's head: arm one read (a no-op while one is already due). */
  async arm(): Promise<void> {
    // ponytail: reads are capped at one per MIN_READ_GAP_MS (~4.3k/day per campus under abuse); no per-path limit
    if (this.armed) return;
    this.armed = true;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    const now = Date.now();
    await this.ctx.storage.setAlarm(Math.max(now + ALARM_DELAY_MS, this.lastReadAt + MIN_READ_GAP_MS));
  }

  private me(uid: string): number {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM users WHERE uid = ?", uid).toArray();
    return rows.length ? Number(rows[0].v) : 0;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_FRAME) return;
    let msg: { t?: unknown; path?: unknown; campuses?: unknown; email?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "poke" && typeof msg.path === "string" && msg.path.length <= 256) {
      // The writer says which heads it moved (`campuses`; absent = its own). Each named hub arms its own read, so a
      // write on another campus, or on every campus (grants, terms, roles), reaches those campuses' clients too.
      const own = await this.ctx.storage.get<string>("campus");
      const named = Array.isArray(msg.campuses) ? msg.campuses.filter((c): c is string => CAMPUSES.includes(c as string)) : [];
      const targets = named.length ? [...new Set(named)] : own ? [own] : [];
      const now = Date.now();
      const far = now - (this.fanoutAt.get(ws) ?? -Infinity) >= FANOUT_GAP_MS;
      if (targets.some((c) => c !== own) && far) this.fanoutAt.set(ws, now);
      for (const c of targets) {
        if (c === own) await this.arm();
        else if (far) await campusHub(this.env, c).arm();
      }
    } else if (msg.t === "pokeUser" && typeof msg.email === "string" && msg.email.length <= 254) {
      // The appointer tells every hub that this person's roles changed. No data travels: the worst a stranger
      // can do is make the target re-read their own roles; one sender gets USER_POKES_PER_HOUR of those, and the
      // target's app coalesces what arrives.
      const now = Date.now();
      if (now - (this.userAt.get(ws) ?? -Infinity) < USER_GAP_MS) return;
      this.userAt.set(ws, now);
      const uid = this.ctx.getTags(ws)[0];
      let c = this.sent.get(uid);
      if (!c || now - c.from >= 3_600_000) {
        if (this.sent.size >= MAX_SENDERS) this.sent.clear();
        this.sent.set(uid, (c = { from: now, n: 0 }));
      }
      if (++c.n > USER_POKES_PER_HOUR) return;
      const email = msg.email.trim().toLowerCase();
      const own = await this.ctx.storage.get<string>("campus");
      await Promise.all(CAMPUSES.map((c) => (c === own ? this.notifyUser(email) : campusHub(this.env, c).notifyUser(email))));
    } else if (msg.t === "pokeMe") {
      const uid = this.ctx.getTags(ws)[0];
      const now = Date.now();
      if (now - (this.pokeMeAt.get(ws) ?? -Infinity) < POKE_ME_GAP_MS) return;
      this.pokeMeAt.set(ws, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO users (uid, v) VALUES (?, 1) ON CONFLICT(uid) DO UPDATE SET v = v + 1",
        uid
      );
      const out = JSON.stringify({ t: "me", v: this.me(uid) });
      for (const s of this.ctx.getWebSockets(uid)) s.send(out);
    }
  }

  async alarm(): Promise<void> {
    this.armed = false;
    this.lastReadAt = Date.now();
    const campus = await this.ctx.storage.get<string>("campus");
    if (!campus) return;
    let next: Versions;
    try {
      next = markers(await readDoc(`heads/${campus}`, this.env));
    } catch {
      if (this.retries++ < MAX_RETRIES) {
        this.armed = true;
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      }
      return;
    }
    this.retries = 0;
    this.cache = { head: next, at: Date.now() };
    const prev = this.last ?? (await this.ctx.storage.get<Versions>("last")) ?? {};
    const diff = diffVersions(prev, next);
    this.last = next;
    await this.ctx.storage.put("last", next);
    if (!Object.keys(diff).length) return;
    const out = JSON.stringify({ t: "head", v: diff });
    for (const s of this.ctx.getWebSockets()) s.send(out);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
}
