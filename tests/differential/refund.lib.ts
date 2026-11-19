/** Shared refund differential: cases, the original runner, and a migrated runner for any app config. */
/**
 * Migration 2: createLegacyRefundService.requestRefund vs refund.request (hybrid).
 * Structured path (the original API's `reason`): differential, exact, no model.
 * Includes the $900 precedence case: the original refuses `over_limit` before any reason rule.
 */
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seed, type SeedOrder } from "@modelnativ/example-refund-migrated";
import { createLegacyRefundService, type Reason } from "@modelnativ/example-refund-original";
import { ScriptedModel } from "@modelnativ/model-adapter";
import { createApp, testEnv } from "@modelnativ/runtime";
import type { AppConfig } from "@modelnativ/runtime";
import type { Observed } from "./harness.ts";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const REFUND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../examples/refund-original/modelnativ");
export type Case = { order: SeedOrder; reason: Reason; user: { id: string; tenantId: string } };

const state = (db: Database.Database) => ({
  orders: db.prepare("SELECT id, refundable_cents, version FROM orders ORDER BY id").all(),
  refunds: db.prepare("SELECT order_id, amount_cents FROM refunds ORDER BY order_id").all(),
});

export async function runOriginal(c: Case): Promise<Observed> {
  const db = new Database(":memory:");
  seed(db, NOW, [c.order]);
  let n = 0;
  const d = await createLegacyRefundService(db, () => NOW, () => `rf_${++n}`).requestRefund(c.user, { orderId: c.order.id, reason: c.reason }, "key-0001");
  return d.outcome === "ALLOW" ? { outcome: "ALLOW", amount: d.amountCents, state: state(db), external: 0 } : { outcome: d.outcome, reason: d.reason, state: state(db), external: 0 };
}

/** A model that must never be called: the structured path is deterministic. */
export const never = new ScriptedModel(() => new Error("model called on a structured request"));

export async function runMigrated(c: Case, config: AppConfig, appDir: string): Promise<Observed> {
  const db = new Database(":memory:");
  seed(db, NOW, [c.order]);
  const env = testEnv(1);
  env.clock.advance(NOW - env.clock.now());
  const app = createApp(config, appDir, { env, db, model: never });
  const r = await app.engines[0]!.handle({ principal: { subject: c.user.id, tenant: c.user.tenantId, sessionId: "s", scopes: ["refund:request"], expiresAt: NOW + 60_000 }, body: { orderId: c.order.id, reason: c.reason }, idempotencyKey: "key-0001" });
  if (r.outcome === "ALLOW") return { outcome: "ALLOW", amount: Number(r.effect!.result.amountCents), state: state(db), external: 0 };
  return { outcome: r.outcome as Observed["outcome"], reason: r.reason ?? r.code, state: state(db), external: 0 };
}

export function cases(): Case[] {
  const orders: SeedOrder[] = [];
  let i = 0;
  for (const ageDays of [5, 31, 50, 70])
    for (const totalCents of [0, 4500, 90000])
      for (const damaged of [null, true, false])
        for (const delivered of [null, true, false])
          for (const owner of ["u_alice", "u_bob"]) orders.push({ id: `ord_${++i}`, tenant: "t_acme", owner, ageDays, totalCents, damaged, delivered: delivered as boolean | null });
  orders.push({ id: "ord_other_tenant", tenant: "t_globex", owner: "u_gina", ageDays: 5, totalCents: 4500, delivered: true });
  const out: Case[] = [];
  for (const order of orders) for (const reason of ["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "OTHER"] as Reason[]) out.push({ order, reason, user: { id: "u_alice", tenantId: "t_acme" } });
  for (const reason of ["DAMAGED", "CHANGED_MIND"] as Reason[]) out.push({ order: orders.at(-1)!, reason, user: { id: "u_alice", tenantId: "t_acme" } });
  return out;
}

