/**
 * A/B/C steady-state benchmark: one app per approach (as in a running server), a fresh seeded DB
 * per round, 300 warm-up requests then 2000 measured, each on a distinct entity with a mixed
 * outcome. The original service runs on the same data as a baseline.
 *   tsx --expose-gc bench/approaches.ts   (node flag passed through NODE_OPTIONS)
 * Reports latency percentiles, throughput, prepared statements per request, retained heap.
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RedemptionService, seedLoyalty, type Account } from "@modelnativ/example-loyalty-original";
import { seed as seedRefund, type SeedOrder } from "@modelnativ/example-refund-migrated";
import { createLegacyRefundService, type Reason } from "@modelnativ/example-refund-original";
import { SubscriptionService, openDatabase, seed as seedSub } from "@modelnativ/example-subscription-original";
import { ScriptedModel } from "@modelnativ/model-adapter";
import { createApp, testEnv, type AppConfig } from "@modelnativ/runtime";
import { fulfillment } from "../examples/loyalty-original/modelnativ/adapters.ts";
import loyaltyA from "../examples/loyalty-original/modelnativ/modelnativ.config.ts";
import loyaltyB from "../examples/loyalty-original/modelnativ/b/modelnativ.config.ts";
import loyaltyC from "../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import refundA from "../examples/refund-original/modelnativ/modelnativ.config.ts";
import refundB from "../examples/refund-original/modelnativ/b/modelnativ.config.ts";
import refundC from "../examples/refund-original/modelnativ/c/modelnativ.config.ts";
import subA from "../examples/subscription-original/modelnativ/a/modelnativ.config.ts";
import subB from "../examples/subscription-original/modelnativ/b/modelnativ.config.ts";
import subC from "../examples/subscription-original/modelnativ/c/modelnativ.config.ts";

const root = new URL("..", import.meta.url).pathname;
const WARM = 300;
const N = 2000;
const ROUNDS = 3;
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const key = (i: number) => `bench-key-${String(i).padStart(6, "0")}`;

type Runner = { db: Database.Database; run: (i: number) => Promise<string> };
type Workflow = { name: string; original: () => Runner; migrated: (cfg: AppConfig, dir: string) => Runner; variants: [string, AppConfig, string][] };

// ---------------------------------------------------------------- loyalty
const LNOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const tiers = ["bronze", "silver", "gold"] as const;
function loyaltyDb() {
  const db = new Database(":memory:");
  const accts: Account[] = Array.from({ length: WARM + N }, (_, i) => ({ member: `m_${i}`, tenant: "t_a", points: [150, 600, 5000][i % 3]!, tier: tiers[i % 3]!, status: i % 17 === 0 ? "suspended" : "active" }));
  seedLoyalty(db, accts, [
    { id: "rw_1", tenant: "t_a", cost: 100, stock: 1_000_000, minTier: "bronze" },
    { id: "rw_2", tenant: "t_a", cost: 300, stock: 1_000_000, minTier: "gold" },
    { id: "rw_3", tenant: "t_a", cost: 100, stock: 0, minTier: "bronze" },
  ]);
  return db;
}
const lreq = (i: number) => ({ rewardId: ["rw_1", "rw_1", "rw_2", "rw_3"][i % 4]!, quantity: 1 + (i % 3) });
const fakeFetch = (async () => new Response("ok")) as typeof fetch;
const loyalty: Workflow = {
  name: "loyalty",
  original: () => {
    const db = loyaltyDb();
    globalThis.fetch = fakeFetch;
    // the original's redemption id is `rd_${now}`: same-millisecond redemptions collide, so its clock ticks per request
    let t = LNOW;
    const svc = new RedemptionService(db, () => t, "http://fulfillment.test");
    return { db, run: async (i) => ((t = LNOW + i), svc.redeem({ id: `m_${i}`, tenantId: "t_a" }, lreq(i)).status) };
  },
  migrated: (cfg, dir) => {
    const db = loyaltyDb();
    const env = testEnv(1);
    env.clock.advance(LNOW - env.clock.now());
    const app = createApp({ ...cfg, destinations: () => [fulfillment("http://fulfillment.test", fakeFetch)] }, dir, { env, db });
    const e = app.engines[0]!;
    return { db, run: async (i) => (await e.handle({ principal: { subject: `m_${i}`, tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: LNOW + 3_600_000 }, body: lreq(i), idempotencyKey: key(i) })).outcome };
  },
  variants: [["A", loyaltyA, "examples/loyalty-original/modelnativ"], ["B", loyaltyB, "examples/loyalty-original/modelnativ/b"], ["C", loyaltyC, "examples/loyalty-original/modelnativ/c"]],
};

// ---------------------------------------------------------------- refund
const reasons: Reason[] = ["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "OTHER"];
function refundDb() {
  const db = new Database(":memory:");
  const h = (i: number, salt: number, n: number) => (((i + 1) * 2654435761 + salt * 40503) >>> 0) % n; // decorrelated fields
  const orders: SeedOrder[] = Array.from({ length: WARM + N }, (_, i) => ({ id: `ord_${i}`, tenant: "t_acme", owner: h(i, 1, 11) === 0 ? "u_bob" : "u_alice", ageDays: [5, 5, 31, 50, 70][h(i, 2, 5)]!, totalCents: [4500, 4500, 90000, 0][h(i, 3, 4)]!, damaged: [null, true, false][h(i, 4, 3)]!, delivered: [true, true, null, false][h(i, 5, 4)]! }));
  seedRefund(db, LNOW, orders);
  return db;
}
const never = new ScriptedModel(() => new Error("model called"));
const refund: Workflow = {
  name: "refund",
  original: () => {
    const db = refundDb();
    let n = 0;
    const svc = createLegacyRefundService(db, () => LNOW, () => `rf_${++n}`);
    return { db, run: async (i) => (await svc.requestRefund({ id: "u_alice", tenantId: "t_acme" }, { orderId: `ord_${i}`, reason: reasons[i % 4]! }, key(i))).outcome };
  },
  migrated: (cfg, dir) => {
    const db = refundDb();
    const env = testEnv(1);
    env.clock.advance(LNOW - env.clock.now());
    const e = createApp(cfg, dir, { env, db, model: never }).engines[0]!;
    return { db, run: async (i) => (await e.handle({ principal: { subject: "u_alice", tenant: "t_acme", sessionId: "s", scopes: ["refund:request"], expiresAt: LNOW + 3_600_000 }, body: { orderId: `ord_${i}`, reason: reasons[i % 4]! }, idempotencyKey: key(i) })).outcome };
  },
  variants: [["A", refundA, "examples/refund-original/modelnativ"], ["B", refundB, "examples/refund-original/modelnativ/b"], ["C", refundC, "examples/refund-original/modelnativ/c"]],
};

// ---------------------------------------------------------------- subscription
const SNOW = new Date("2026-03-11T00:00:00.000Z");
const plans = ["plan_starter", "plan_pro", "plan_business"];
const targets = ["plan_starter", "plan_pro", "plan_business", "plan_enterprise", "plan_legacy"];
function subDb() {
  const db = openDatabase();
  seedSub(db, { now: SNOW });
  const ins = db.prepare("INSERT INTO subscriptions (id, account_id, plan_id, status, seats_in_use, current_period_start, current_period_end, promo_lock_until, version, updated_at) VALUES (?, 'acct_a', ?, ?, ?, '2026-03-01T00:00:00.000Z', '2026-03-31T00:00:00.000Z', NULL, 1, ?)");
  db.transaction(() => { for (let i = 0; i < WARM + N; i++) ins.run(`sub_${i}`, plans[i % 3], i % 13 === 0 ? "past_due" : "active", [3, 30][i % 2], SNOW.toISOString()); })();
  return db;
}
const sreq = (i: number) => ({ subscriptionId: `sub_${i}`, targetPlanId: targets[(i * 7) % 5]! });
const callers = ["user_admin", "user_admin", "user_billing", "user_member"];
const subscription: Workflow = {
  name: "subscription",
  original: () => {
    const db = subDb();
    const svc = new SubscriptionService({ db, now: () => SNOW, billing: { notifyPlanChanged: async () => {} }, logger: { warn() {} } });
    return { db, run: async (i) => { const r = await svc.changePlan({ userId: callers[i % 4]!, tenantId: "tenant_a" }, sreq(i)); return r.status === "rejected" ? r.reason : r.status; } };
  },
  migrated: (cfg, dir) => {
    const db = subDb();
    const env = testEnv(1);
    env.clock.advance(SNOW.getTime() - env.clock.now());
    const fake = { name: "billing", secrets: [], send: async (p: Record<string, unknown>) => ({ externalId: String(p.version) }) };
    const e = createApp({ ...cfg, destinations: () => [fake] }, dir, { env, db }).engines[0]!;
    return { db, run: async (i) => { const r = await e.handle({ principal: { subject: callers[i % 4]!, tenant: "tenant_a", sessionId: "s", scopes: ["subscription:change-plan"], expiresAt: SNOW.getTime() + 3_600_000 }, body: sreq(i), idempotencyKey: key(i) }); return r.outcome === "ALLOW" ? String(r.effect!.result.status) : (r.reason ?? r.code ?? r.outcome); } };
  },
  variants: [["A", subA, "examples/subscription-original/modelnativ/a"], ["B", subB, "examples/subscription-original/modelnativ/b"], ["C", subC, "examples/subscription-original/modelnativ/c"]],
};

// ---------------------------------------------------------------- measure
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
async function measure(make: () => Runner) {
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const r = make();
  let prepares = 0;
  const realPrepare = r.db.prepare.bind(r.db);
  (r.db as { prepare: unknown }).prepare = (sql: string) => (prepares++, realPrepare(sql));
  for (let i = 0; i < WARM; i++) await r.run(i);
  prepares = 0;
  const lat: number[] = [];
  const mix: Record<string, number> = {};
  const t0 = performance.now();
  for (let i = WARM; i < WARM + N; i++) {
    const s = performance.now();
    const out = await r.run(i);
    lat.push(performance.now() - s);
    mix[out] = (mix[out] ?? 0) + 1;
  }
  const wall = performance.now() - t0;
  gc();
  const heap1 = process.memoryUsage().heapUsed;
  return { lat, wall, prepares: prepares / N, heapMb: (heap1 - heap0) / 1e6, mix };
}

const results: Record<string, unknown> = {};
for (const wf of [loyalty, refund, subscription]) {
  const all: Record<string, { lat: number[]; wall: number; prepares: number; heapMb: number[]; mix: Record<string, number> }> = {};
  const variants: [string, () => Runner][] = [["original", wf.original], ...wf.variants.map(([n, c, d]) => [n, () => wf.migrated(c, join(root, d))] as [string, () => Runner])];
  for (let round = 0; round < ROUNDS; round++)
    for (const [name, make] of variants) {
      const m = await measure(make);
      if (round === 0) continue; // round 0 warms the JIT for every variant
      const acc = (all[name] ??= { lat: [], wall: 0, prepares: m.prepares, heapMb: [], mix: m.mix });
      acc.lat.push(...m.lat);
      acc.wall += m.wall;
      acc.heapMb.push(m.heapMb);
    }
  console.log(`\n${wf.name}  (${(ROUNDS - 1) * N} measured requests per variant; mix ${JSON.stringify(all.A!.mix)})`);
  console.log("variant    p50 ms   p95 ms   p99 ms   req/s   prepares/req  retained heap MB");
  const row: Record<string, unknown> = {};
  for (const [name, a] of Object.entries(all)) {
    const s = [...a.lat].sort((x, y) => x - y);
    const r = { p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), rps: (a.lat.length / a.wall) * 1000, prepares: a.prepares, heapMb: Math.max(...a.heapMb) };
    row[name] = r;
    console.log(`${name.padEnd(9)} ${r.p50.toFixed(3).padStart(7)} ${r.p95.toFixed(3).padStart(8)} ${r.p99.toFixed(3).padStart(8)} ${r.rps.toFixed(0).padStart(7)} ${r.prepares.toFixed(1).padStart(13)} ${r.heapMb.toFixed(1).padStart(17)}`);
  }
  results[wf.name] = row;
}
writeFileSync(join(root, "bench/results/approaches.json"), JSON.stringify({ when: new Date().toISOString(), node: process.version, warm: WARM, n: N, rounds: ROUNDS, results }, null, 2));
