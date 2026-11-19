/**
 * Incremental migration inside the existing Express app: same controller, same routes, same
 * auth, same validation; only RedemptionService.redeem is replaced (embedded SDK, modelnativ mode).
 * HTTP responses are compared with the original for valid, invalid and unauthenticated requests.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedemptionService, createLoyaltyApp, seedLoyalty, type Member, type RedeemRequest, type RedeemResult } from "@modelnativ/example-loyalty-original";
import { createModelnativ } from "@modelnativ/core";
import { createApp, testEnv } from "@modelnativ/runtime";
import config from "../../examples/loyalty-original/modelnativ/modelnativ.config.ts";
import { fulfillment } from "../../examples/loyalty-original/modelnativ/adapters.ts";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../examples/loyalty-original/modelnativ");
const USERS: Record<string, Member> = { "tok-m1": { id: "m_1", tenantId: "t_a" } };

function fixtures(db: Database.Database) {
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 450, tier: "silver", status: "active" }], [
    { id: "rw_cheap", tenant: "t_a", cost: 100, stock: 2, minTier: "bronze" },
    { id: "rw_gold", tenant: "t_a", cost: 50, stock: 9, minTier: "gold" },
  ]);
}

async function serve(migrated: boolean) {
  const db = new Database(":memory:");
  fixtures(db);
  let service: { redeem(m: Member, r: RedeemRequest): RedeemResult | Promise<RedeemResult> } = new RedemptionService(db, () => NOW, "http://f.test");
  if (migrated) {
    const env = testEnv(2);
    env.clock.advance(NOW - env.clock.now());
    const app = createApp({ ...config, destinations: () => [fulfillment("http://f.test", (async () => new Response("ok")) as typeof fetch)] }, APP_DIR, { env, db });
    const mn = createModelnativ(app.engines, { modes: { "loyalty.redeem": "modelnativ" } });
    const legacy = service;
    service = {
      redeem: mn.bind("loyalty.redeem", async (m: Member, r: RedeemRequest) => legacy.redeem(m, r), {
        principal: (m) => ({ subject: m.id, tenant: m.tenantId, sessionId: "host", scopes: ["loyalty:redeem"], expiresAt: NOW + 60_000 }),
        input: (_m, r) => ({ rewardId: r.rewardId, quantity: r.quantity, ...(r.note !== undefined ? { note: r.note } : {}) }),
        // The original API has no idempotency key: a fresh key per call preserves its behaviour.
        idempotencyKey: () => `host-${randomUUID()}`,
        output: (res): RedeemResult =>
          res.outcome === "ALLOW"
            ? { status: "redeemed", redemptionId: String(res.effect!.result.redemptionId), pointsSpent: Number(res.effect!.result.pointsSpent) }
            : { status: "rejected", reason: (res.reason ?? "not_found") as never },
        normalizeLegacy: (r) => ({ outcome: r.status === "redeemed" ? "ALLOW" : "REFUSE" }),
        normalizeModelnativ: (r) => ({ outcome: r.outcome === "ALLOW" ? "ALLOW" : "REFUSE" }),
      }),
    };
  }
  const server = createLoyaltyApp(db, (t) => (t ? USERS[t] ?? null : null), "http://f.test", service).listen(0); // controller unchanged
  const port = (server.address() as { port: number }).port;
  const post = async (token: string | null, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/redemptions`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    const json = text ? JSON.parse(text) : null;
    if (json?.redemptionId) json.redemptionId = "<id>";
    return { status: r.status, body: json };
  };
  return { post, close: () => server.close(), db };
}

describe("loyalty: replace one function inside the existing Express app", () => {
  // The ORIGINAL service fires a real fetch() after commit; keep it off the network in tests.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: unknown, init?: unknown) =>
      String(url).startsWith("http://127.0.0.1") ? realFetch(url as string, init as RequestInit) : new Response("ok")) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  it("same HTTP behaviour for a sequence of valid, invalid and unauthenticated requests", { timeout: 30_000 }, async () => {
    const seq: [string | null, unknown][] = [
      ["tok-m1", { rewardId: "rw_cheap", quantity: 2 }], // redeemed, 200 points
      ["tok-m1", { rewardId: "rw_cheap", quantity: 1 }], // out of stock now
      ["tok-m1", { rewardId: "rw_gold", quantity: 1 }], // tier required
      ["tok-m1", { rewardId: "rw_none", quantity: 1 }], // not found
      ["tok-m1", { rewardId: "rw_cheap", quantity: 0 }], // controller: 400
      ["tok-m1", { rewardId: "rw_cheap", quantity: 1.5 }], // controller: 400
      [null, { rewardId: "rw_cheap", quantity: 1 }], // 401
      ["tok-m1", { rewardId: "rw_cheap", quantity: 1, note: "for my mum" }],
    ];
    const a = await serve(false);
    const b = await serve(true);
    try {
      for (const [tok, body] of seq) expect(await b.post(tok, body), JSON.stringify(body)).toEqual(await a.post(tok, body));
      const pts = (db: Database.Database) => db.prepare("SELECT points FROM loyalty_accounts").get();
      expect(pts(b.db)).toEqual(pts(a.db));
    } finally {
      a.close();
      b.close();
    }
  });
});
