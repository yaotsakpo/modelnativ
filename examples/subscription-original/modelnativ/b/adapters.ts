// Approach B: same explicit contract as A (../a/plan.change.yaml); adapters from primitives.
import type Database from "better-sqlite3";
import { configFacts, sqlEffect, sqlRead } from "@modelnativ/runtime";
import type { SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";
import { CHANGE_SQL, changeFacts, event, policyFacts } from "../change-kind.ts";
export { billing } from "../a/adapters.ts";

export const tools = (db: Database.Database, now: () => number, cfg: Partial<SubscriptionServiceConfig> = {}) => [
  configFacts("policy.get", policyFacts(cfg)),
  sqlRead(db, {
    name: "subscriptions.get",
    sql: `SELECT s.id, s.account_id, a.tenant_id, s.plan_id, s.status, s.seats_in_use, s.current_period_start, s.promo_lock_until, s.version
          FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.tenant_id = ?`,
    params: ["id", "tenant"],
    tenantParam: "tenant",
    facts: {
      "sub.id": "id", "sub.accountId": "account_id", "sub.tenantId": "tenant_id", "sub.planId": "plan_id", "sub.status": "status",
      "sub.seatsInUse": "seats_in_use", "sub.version": "version", "sub.periodStart": "current_period_start",
      "sub.promoLockActive": (r) => !!r.promo_lock_until && new Date(String(r.promo_lock_until)).getTime() > now(),
    },
  }),
  sqlRead(db, {
    name: "members.get",
    sql: "SELECT user_id, role FROM account_members WHERE account_id = ? AND user_id = ?",
    params: ["account", "user"],
    facts: { "member.userId": "user_id", "member.canChangePlan": (r) => r.role === "admin" || r.role === "billing_manager" },
  }),
  sqlRead(db, { name: "plans.target", sql: "SELECT id, purchasable, seat_limit FROM plans WHERE id = ?", params: ["id"], booleans: ["purchasable"], facts: { "target.id": "id", "target.purchasable": "purchasable", "target.seatLimit": "seat_limit" } }),
  sqlRead(db, { name: "invoices.pending", sql: "SELECT COUNT(*) AS n FROM invoices WHERE subscription_id = ? AND status = 'pending'", params: ["sub"], facts: { "billing.pendingInvoices": "n" } }),
  sqlRead(db, { name: "history.period", sql: "SELECT COUNT(*) AS n FROM plan_change_history WHERE subscription_id = ? AND changed_at >= ?", params: ["sub", "since"], facts: { "history.changesThisPeriod": "n" } }),
  sqlRead(db, {
    name: "change.compute",
    sql: CHANGE_SQL,
    params: ["to", "sub"],
    facts: {},
    // One computation per row for all three facts (previously computed three times).
    derive: [{ facts: ["change.direction", "change.prorationCents", "change.kind"], compute: (r, a) => {
      const f = changeFacts(r as never, now(), Number(a.threshold));
      return { "change.direction": f.direction, "change.prorationCents": f.prorationCents, "change.kind": f.kind };
    } }],
  }),
];

const iso = (now: number) => new Date(now).toISOString();
const p = (c: { args: Record<string, string | number> }) => Number(c.args.prorationCents);

export const applyAdapter = sqlEffect({
  tool: "plan.change.apply",
  steps: [
    { write: "UPDATE subscriptions SET plan_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?", params: (c) => [c.args.toPlanId, iso(c.now), c.args.subscriptionId, c.args.expectedVersion], refuse: { code: "STALE_STATE", reason: "version_conflict" } },
    { when: (c) => p(c) > 0, insert: "INSERT INTO invoice_items (id, subscription_id, invoice_id, amount_cents, description, created_at) VALUES (?, ?, NULL, ?, ?, ?)", params: (c) => [`${c.effectId}_ii`, c.args.subscriptionId, p(c), `Proration ${c.args.fromPlanId} -> ${c.args.toPlanId}`, iso(c.now)] },
    { when: (c) => p(c) < 0, insert: "INSERT INTO credit_notes (id, subscription_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)", params: (c) => [`${c.effectId}_cn`, c.args.subscriptionId, -p(c), `Proration ${c.args.fromPlanId} -> ${c.args.toPlanId}`, iso(c.now)] },
    { insert: "INSERT INTO plan_change_history (id, subscription_id, from_plan_id, to_plan_id, direction, proration_cents, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params: (c) => [`${c.effectId}_h`, c.args.subscriptionId, c.args.fromPlanId, c.args.toPlanId, c.args.direction, p(c), c.args.changedBy, iso(c.now)] },
  ],
  result: (c) => ({ status: "changed", subscriptionId: c.args.subscriptionId, fromPlanId: c.args.fromPlanId, toPlanId: c.args.toPlanId, direction: c.args.direction, prorationCents: p(c), version: Number(c.args.expectedVersion) + 1 }),
  outbox: (c) => [{ destination: "billing", payload: event(c.args, Number(c.args.expectedVersion) + 1, c.now) }],
});

export const approvalAdapter = sqlEffect({
  tool: "plan.change.requestApproval",
  steps: [
    { insert: "INSERT INTO plan_change_requests (id, subscription_id, from_plan_id, to_plan_id, proration_cents, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)", params: (c) => [c.effectId, c.args.subscriptionId, c.args.fromPlanId, c.args.toPlanId, p(c), c.args.requestedBy, iso(c.now)] },
  ],
  result: (c) => ({ status: "pending_approval", subscriptionId: c.args.subscriptionId, approvalRequestId: c.effectId, fromPlanId: c.args.fromPlanId, toPlanId: c.args.toPlanId, direction: "upgrade", prorationCents: p(c) }),
});
