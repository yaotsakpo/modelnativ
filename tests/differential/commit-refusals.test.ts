/**
 * Test gap found by the reviewability study: no test exercised the adapters' IN-TRANSACTION
 * refusals (the re-checks that fire when state changed between the decision and the commit), and
 * the subscription race accepted a conflict reported as `same_plan`. Each race below explores every
 * interleaving (actors off), asserts the exact reason, and asserts that at least one schedule took
 * the commit-time path (so the test cannot pass vacuously).
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { seed as seedRefund } from "@modelnativ/example-refund-migrated";
import { openDatabase, seed as seedSub } from "@modelnativ/example-subscription-original";
import { MemoryTraces } from "@modelnativ/observability";
import { ControlledScheduler, createApp, exploreSchedules, testEnv, type AppConfig, type OperationResult } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import refundC from "../../examples/refund-original/modelnativ/c/modelnativ.config.ts";
import subC from "../../examples/subscription-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "./loyalty.lib.ts";
import { REFUND_ROOT, never } from "./refund.lib.ts";
import { SUB_ROOT } from "./subscription.lib.ts";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
type Race = { config: AppConfig; dir: string; seed: (db: Database.Database) => void; now?: number; db?: () => Database.Database; model?: boolean; requests: [string, Record<string, unknown>, string][]; scopes: string[]; tenant: string };

/** Run every schedule; return the per-schedule results and whether a commit-time refusal with `reason` occurred. */
async function race(r: Race, check: (results: OperationResult[], db: Database.Database) => void, commitReason: string) {
  let commitTimeRefusals = 0;
  const res = await exploreSchedules(async () => {
    const scheduler = new ControlledScheduler();
    const db = r.db ? r.db() : new Database(":memory:");
    r.seed(db);
    const env = testEnv(1, { scheduler });
    env.clock.advance((r.now ?? NOW) - env.clock.now());
    const traces = new MemoryTraces();
    const app = createApp({ ...r.config, destinations: () => [{ name: "fulfillment", secrets: [], send: async () => ({ externalId: "x" }) }, { name: "billing", secrets: [], send: async () => ({ externalId: "x" }) }] }, r.dir, { env, db, traces, engine: { serialize: false }, ...(r.model ? { model: never } : {}) });
    const tasks = Object.fromEntries(r.requests.map(([subject, body, key], i) => [String.fromCharCode(65 + i), () => app.engines[0]!.handle({ principal: { subject, tenant: r.tenant, sessionId: "s", scopes: r.scopes, expiresAt: (r.now ?? NOW) + 60_000 }, body, idempotencyKey: key })]));
    return {
      scheduler,
      tasks,
      check: (out) => {
        expect(out.deadlock).toBe(false);
        check(Object.values(out.results) as OperationResult[], db);
        for (const t of traces.traces.values())
          for (const c of t.commits) {
            const cr = c.result as { status?: string; code?: string; reason?: string } | undefined;
            if (cr?.status === "refused" && (cr.reason === commitReason || cr.code === commitReason)) commitTimeRefusals++;
          }
      },
    };
  });
  expect(res.exhaustive).toBe(true);
  expect(commitTimeRefusals).toBeGreaterThan(0); // the in-transaction path really ran in some schedule
  return res;
}
const oneAllow = (rs: OperationResult[]) => {
  expect(rs.filter((x) => x.outcome === "ALLOW")).toHaveLength(1);
  return rs.find((x) => x.outcome !== "ALLOW")!;
};
const L = { config: loyaltyC, dir: join(LOYALTY_ROOT, "c"), scopes: ["loyalty:redeem"], tenant: "t_a" };

describe("in-transaction refusals under concurrency (exhaustive, actors off)", { timeout: 300_000 }, () => {
  it("loyalty: the last unit: the loser is refused out_of_stock (at the gate or at commit)", async () => {
    await race({ ...L, seed: (db) => seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 500, tier: "gold", status: "active" }, { member: "m_2", tenant: "t_a", points: 500, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 1, minTier: "bronze" }]),
      requests: [["m_1", { rewardId: "rw_1", quantity: 1 }, "oos-key-0001"], ["m_2", { rewardId: "rw_1", quantity: 1 }, "oos-key-0002"]] },
      (rs) => expect(oneAllow(rs).reason).toBe("out_of_stock"), "out_of_stock");
  });

  it("loyalty: points for one redemption only: the loser is refused insufficient_points", async () => {
    await race({ ...L, seed: (db) => seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 150, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 9, minTier: "bronze" }, { id: "rw_2", tenant: "t_a", cost: 100, stock: 9, minTier: "bronze" }]),
      requests: [["m_1", { rewardId: "rw_1", quantity: 1 }, "pts-key-0001"], ["m_1", { rewardId: "rw_2", quantity: 1 }, "pts-key-0002"]] },
      (rs, db) => {
        expect(oneAllow(rs).reason).toBe("insufficient_points");
        expect((db.prepare("SELECT points FROM loyalty_accounts").get() as { points: number }).points).toBe(50);
      }, "insufficient_points");
  });

  it("loyalty: one redemption left today: the loser is refused daily_limit", async () => {
    await race({ ...L, seed: (db) => seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 5000, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 9, minTier: "bronze" }, { id: "rw_2", tenant: "t_a", cost: 100, stock: 9, minTier: "bronze" }], [{ member: "m_1", at: NOW - 3_600_000 }, { member: "m_1", at: NOW - 7_200_000 }]),
      requests: [["m_1", { rewardId: "rw_1", quantity: 1 }, "day-key-0001"], ["m_1", { rewardId: "rw_2", quantity: 1 }, "day-key-0002"]] },
      (rs) => expect(oneAllow(rs).reason).toBe("daily_limit"), "daily_limit");
  });

  it("refund: two requests for one order: the version check refuses at commit, the re-decision answers nothing_to_refund", async () => {
    await race({ config: refundC, dir: join(REFUND_ROOT, "c"), scopes: ["refund:request"], tenant: "t_acme", model: true,
      seed: (db) => seedRefund(db, NOW, [{ id: "ord_1", tenant: "t_acme", owner: "u_alice", ageDays: 5, totalCents: 4500, damaged: true, delivered: true }]),
      requests: [["u_alice", { orderId: "ord_1", reason: "DAMAGED" }, "rf-key-0001"], ["u_alice", { orderId: "ord_1", reason: "DAMAGED" }, "rf-key-0002"]] },
      (rs, db) => {
        expect(oneAllow(rs).reason).toBe("nothing_to_refund");
        expect((db.prepare("SELECT COUNT(*) n FROM refunds").get() as { n: number }).n).toBe(1);
      }, "STALE_STATE");
  });

  it("subscription: two changes with the same expectedVersion: the loser is refused version_conflict (exactly)", async () => {
    const SNOW = Date.parse("2026-03-11T00:00:00.000Z");
    await race({ config: subC, dir: join(SUB_ROOT, "c"), scopes: ["subscription:change-plan"], tenant: "tenant_a", now: SNOW, db: () => openDatabase(),
      seed: (db) => seedSub(db, { now: new Date(SNOW), planId: "plan_business" }),
      requests: [["user_admin", { subscriptionId: "sub_a", targetPlanId: "plan_pro", expectedVersion: 1 }, "sub-key-0001"], ["user_billing", { subscriptionId: "sub_a", targetPlanId: "plan_starter", expectedVersion: 1 }, "sub-key-0002"]] },
      (rs, db) => {
        expect(oneAllow(rs).reason).toBe("version_conflict");
        expect((db.prepare("SELECT version FROM subscriptions WHERE id='sub_a'").get() as { version: number }).version).toBe(2);
      }, "version_conflict");
  });
});
