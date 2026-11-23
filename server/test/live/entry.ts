// Test-only entry for `wrangler dev` (server/wrangler.live.toml): the real Worker and hub, with the three
// outside services swapped at the fetch boundary so they run against the Firebase emulators:
//   oauth2.googleapis.com          -> a fake access token ("owner" bypasses the emulator's rules)
//   securetoken JWKS               -> the test public key (TEST_JWK)
//   firestore.googleapis.com       -> the Firestore emulator (EMULATOR_FIRESTORE, host:port)
// The Auth emulator's ID tokens are unsigned, so /live requests have theirs re-signed with the test key.
// Production code paths are untouched; this file is never deployed.
import { env } from "cloudflare:workers";
import worker from "../../src/index";
import { CampusHub as Hub } from "../../src/hub";

const real = globalThis.fetch.bind(globalThis);
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
const e = () => env as unknown as Record<string, string>;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "owner", expires_in: 3600 });
  if (url.host === "www.googleapis.com" && url.pathname.includes("/jwk/"))
    return Response.json({ keys: [{ ...JSON.parse(e().TEST_PUBLIC_JWK), kid: "test" }] }, { headers: { "Cache-Control": "max-age=3600" } });
  if (url.host === "firestore.googleapis.com") {
    const to = `http://${e().EMULATOR_FIRESTORE}${url.pathname}${url.search}`;
    return real(typeof input === "string" || input instanceof URL ? to : new Request(to, input as Request), init);
  }
  return real(input as RequestInfo, init);
}) as typeof fetch;

async function resign(token: string): Promise<string> {
  const [h, p] = token.split(".");
  if (unb64(h).alg !== "none") return token; // already signed (a test's own, possibly expired or forged on purpose)
  const claims = { ...unb64(p), iss: `https://securetoken.google.com/${e().PROJECT_ID}`, aud: e().PROJECT_ID };
  claims.sub ??= claims.user_id;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(e().TEST_PRIVATE_JWK), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const input = `${b64({ alg: "RS256", kid: "test", typ: "JWT" })}.${b64(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export class CampusHub extends Hub {}

export default {
  async fetch(req: Request, envv: any, ctx: ExecutionContext): Promise<Response> {
    const proto = req.headers.get("Sec-WebSocket-Protocol");
    if (proto && new URL(req.url).pathname.startsWith("/live/")) {
      const [name, token] = proto.split(",").map((s) => s.trim());
      if (name === "pointer" && token) {
        const fwd = new Request(req);
        try {
          fwd.headers.set("Sec-WebSocket-Protocol", `pointer, ${await resign(token)}`);
        } catch {}
        return worker.fetch(fwd, envv, ctx);
      }
    }
    return worker.fetch(req, envv, ctx);
  },
};
