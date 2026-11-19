/**
 * Concurrency per approach: two members redeem the LAST unit of a reward at the same time.
 * Exhaustive schedule exploration, per-resource actors OFF (only the adapter's guarded writes
 * protect the invariant). Never both may succeed; stock never goes negative.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { ControlledScheduler, createApp, exploreSchedules, testEnv, type AppConfig } from "@modelnativ/runtime";
import loyaltyA from "../../examples/loyalty-original/modelnativ/modelnativ.config.ts";
import loyaltyB from "../../examples/loyalty-original/modelnativ/b/modelnativ.config.ts";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { openDatabase, seed as seedSub } from "@modelnativ/example-subscription-original";
import { seed as seedRefund } from "@modelnativ/example-refund-migrated";
import refundA from "../../examples/refund-original/modelnativ/modelnativ.config.ts";
import refundB from "../../examples/refund-original/modelnativ/b/modelnativ.config.ts";
import refundC from "../../examples/refund-original/modelnativ/c/modelnativ.config.ts";
import subA from "../../examples/subscription-original/modelnativ/a/modelnativ.config.ts";
import subB from "../../examples/subscription-original/modelnativ/b/modelnativ.config.ts";
import subC from "../../examples/subscription-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "./loyalty.lib.ts";
import { REFUND_ROOT, never } from "./refund.lib.ts";
import { SUB_ROOT } from "./subscription.lib.ts";

type R = { outcome: string; reason?: string; code?: string; effect?: { result: Record<string, unknown> } };
const unserialized = (app: { engines: unknown[] }) => {
  const engine = app.engines[0] as { handle: (r: unknown) => Promise<R> };
  (engine as unknown as { d: { serialize: boolean } }).d.serialize = false;
  return engine;
};

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

async function lastUnitRace(config: AppConfig, dir: string, sameKey: "no" | "safety" | "consistency" = "no") {
  return exploreSchedules(async () => {
    const scheduler = new ControlledScheduler();
    const db = new Database(":memory:");
    seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 500, tier: "gold", status: "active" }, { member: "m_2", tenant: "t_a", points: 500, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 1, minTier: "bronze" }]);
    const env = testEnv(1, { scheduler });
    env.clock.advance(NOW - env.clock.now());
    const app = createApp({ ...config, destinations: () => [] }, dir, { env, db });
    // per-resource actors off: the engine is rebuilt without serialisation
    const engine = unserialized(app);
    const go = (m: string) => () => engine.handle({ principal: { subject: m, tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 60_000 }, body: { rewardId: "rw_1", quantity: 1 }, idempotencyKey: `race-${m}-0001` });
    if (sameKey !== "no") return { scheduler, tasks: { A: go("m_1"), B: go("m_1") }, check: (r: { results: Record<string, unknown>; deadlock: boolean }) => {
      expect(r.deadlock).toBe(false);
      const [a, b] = (Object.values(r.results) as R[]);
      if (sameKey === "consistency") expect([b!.outcome, b!.code, b!.reason]).toEqual([a!.outcome, a!.code, a!.reason]);
      expect((db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT points FROM loyalty_accounts WHERE member_id='m_1'").get() as { points: number }).points).toBe(400);
    } };
    return {
      scheduler,
      tasks: { A: go("m_1"), B: go("m_2") },
      check: (r: { results: Record<string, unknown>; deadlock: boolean }) => {
        expect(r.deadlock).toBe(false);
        const ok = (Object.values(r.results) as R[]).filter((x) => (x as { outcome: string }).outcome === "ALLOW").length;
        expect(ok).toBe(1);
        expect((db.prepare("SELECT stock FROM rewards").get() as { stock: number }).stock).toBe(0);
      },
    };
  });
}

/** Two admins change the same subscription at once (both downgrades apply). No lost update: every success has its own version. */
async function subscriptionRace(config: AppConfig, dir: string) {
  const SNOW = new Date("2026-03-11T00:00:00.000Z");
  return exploreSchedules(async () => {
    const scheduler = new ControlledScheduler();
    const db = openDatabase();
    seedSub(db, { now: SNOW, planId: "plan_business" });
    const env = testEnv(1, { scheduler });
    env.clock.advance(SNOW.getTime() - env.clock.now());
    const fake = { name: "billing", secrets: [], send: async (p: Record<string, unknown>) => ({ externalId: String(p.version) }) };
    const engine = unserialized(createApp({ ...config, destinations: () => [fake] }, dir, { env, db }));
    const go = (user: string, target: string) => () => engine.handle({ principal: { subject: user, tenant: "tenant_a", sessionId: "s", scopes: ["subscription:change-plan"], expiresAt: SNOW.getTime() + 60_000 }, body: { subscriptionId: "sub_a", targetPlanId: target }, idempotencyKey: `race-${user}-0001` });
    return {
      scheduler,
      tasks: { A: go("user_admin", "plan_pro"), B: go("user_billing", "plan_starter") },
      check: (r: { results: Record<string, unknown>; deadlock: boolean }) => {
        expect(r.deadlock).toBe(false);
        const ok = (Object.values(r.results) as R[]).filter((x) => x.outcome === "ALLOW");
        for (const x of (Object.values(r.results) as R[])) if (x.outcome !== "ALLOW") expect(x.reason ?? x.code).toBe("version_conflict");
        const sub = db.prepare("SELECT plan_id, version FROM subscriptions WHERE id='sub_a'").get() as { plan_id: string; version: number };
        const hist = (db.prepare("SELECT COUNT(*) n FROM plan_change_history").get() as { n: number }).n;
        expect(ok.length).toBeGreaterThanOrEqual(1);
        expect(hist).toBe(ok.length);
        expect(sub.version).toBe(1 + ok.length);
        expect(new Set(ok.map((x) => x.effect!.result.version)).size).toBe(ok.length);
      },
    };
  });
}

/** Two refund requests for the same order with different idempotency keys: never refund more than is refundable. */
async function refundRace(config: AppConfig, dir: string) {
  return exploreSchedules(async () => {
    const scheduler = new ControlledScheduler();
    const db = new Database(":memory:");
    seedRefund(db, NOW, [{ id: "ord_1", tenant: "t_acme", owner: "u_alice", ageDays: 5, totalCents: 4500, damaged: true, delivered: true }]);
    const env = testEnv(1, { scheduler });
    env.clock.advance(NOW - env.clock.now());
    const engine = unserialized(createApp(config, dir, { env, db, model: never }));
    const go = (k: string) => () => engine.handle({ principal: { subject: "u_alice", tenant: "t_acme", sessionId: "s", scopes: ["refund:request"], expiresAt: NOW + 60_000 }, body: { orderId: "ord_1", reason: "DAMAGED" }, idempotencyKey: `race-key-${k}` });
    return {
      scheduler,
      tasks: { A: go("0001"), B: go("0002") },
      check: (r: { results: Record<string, unknown>; deadlock: boolean }) => {
        expect(r.deadlock).toBe(false);
        const refunded = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM refunds").get() as { s: number }).s;
        const left = (db.prepare("SELECT refundable_cents r FROM orders").get() as { r: number }).r;
        expect((Object.values(r.results) as R[]).filter((x) => x.outcome === "ALLOW").length).toBe(1);
        expect(refunded).toBe(4500);
        expect(left).toBe(0);
      },
    };
  });
}

const APPROACHES = [
  ["A", loyaltyA, LOYALTY_ROOT, refundA, REFUND_ROOT, subA, join(SUB_ROOT, "a")],
  ["B", loyaltyB, join(LOYALTY_ROOT, "b"), refundB, join(REFUND_ROOT, "b"), subB, join(SUB_ROOT, "b")],
  ["C", loyaltyC, join(LOYALTY_ROOT, "c"), refundC, join(REFUND_ROOT, "c"), subC, join(SUB_ROOT, "c")],
] as const;

describe("concurrency per approach (exhaustive schedules, per-resource actors off)", { timeout: 300_000 }, () => {
  for (const [name, lc, ld, rc, rd, sc, sd] of APPROACHES) {
    it(`${name} loyalty: the last unit is never sold twice`, async () => {
      const r = await lastUnitRace(lc, ld);
      expect(r.exhaustive).toBe(true);
      console.log(`${name} loyalty last-unit: ${r.explored} schedules`);
    });
    it(`${name} loyalty: a concurrent retry with the same key commits once`, async () => {
      const r = await lastUnitRace(lc, ld, "safety");
      expect(r.exhaustive).toBe(true);
      console.log(`${name} loyalty same-key: ${r.explored} schedules`);
    });
    // Was a known gap before durable idempotency claims: the duplicate read facts after the first
    // commit and was refused by the gate. Now it waits on the claim and converges on the same answer.
    it(`${name} loyalty: a concurrent retry with the same key gets the same answer`, async () => {
      const r = await lastUnitRace(lc, ld, "consistency");
      expect(r.exhaustive).toBe(true);
      console.log(`${name} loyalty same-key convergence: ${r.explored} schedules`);
    });
    it(`${name} refund: two keys, one order, refunded once`, async () => {
      const r = await refundRace(rc, rd);
      expect(r.exhaustive).toBe(true);
      console.log(`${name} refund double-request: ${r.explored} schedules`);
    });
    it(`${name} subscription: no lost update`, async () => {
      const r = await subscriptionRace(sc, sd);
      expect(r.exhaustive).toBe(true);
      console.log(`${name} subscription race: ${r.explored} schedules`);
    });
  }
});
