// Approach A: hand-written read tools and effect adapters.
import type Database from "better-sqlite3";
import { EffectRefusal, type Destination, type EffectAdapter } from "@modelnativ/effect-executor";
import type { ReadTool } from "@modelnativ/runtime";
import type { SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";
import { CHANGE_SQL, changeFacts, event, policyFacts } from "../change-kind.ts";

export function tools(db: Database.Database, now: () => number, cfg: Partial<SubscriptionServiceConfig> = {}): ReadTool[] {
  const policy = policyFacts(cfg);
  return [
    { name: "policy.get", async read() { return { ...policy }; } },
    {
      name: "subscriptions.get",
      async read(a) {
        const r = db.prepare(`SELECT s.id, s.account_id, a.tenant_id, s.plan_id, s.status, s.seats_in_use, s.current_period_start, s.promo_lock_until, s.version
          FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.tenant_id = ?`).get(a.id, a.tenant) as Record<string, any> | undefined;
        if (!r) return null;
        return {
          "sub.id": r.id, "sub.accountId": r.account_id, "sub.tenantId": r.tenant_id, "sub.planId": r.plan_id, "sub.status": r.status,
          "sub.seatsInUse": r.seats_in_use, "sub.version": r.version, "sub.periodStart": r.current_period_start,
          "sub.promoLockActive": !!r.promo_lock_until && new Date(r.promo_lock_until).getTime() > now(),
        };
      },
    },
    {
      name: "members.get",
      async read(a) {
        const r = db.prepare("SELECT user_id, role FROM account_members WHERE account_id = ? AND user_id = ?").get(a.account, a.user) as { user_id: string; role: string } | undefined;
        if (!r) return null;
        return { "member.userId": r.user_id, "member.canChangePlan": r.role === "admin" || r.role === "billing_manager" };
      },
    },
    {
      name: "plans.target",
      async read(a) {
        const r = db.prepare("SELECT id, purchasable, seat_limit FROM plans WHERE id = ?").get(a.id) as { id: string; purchasable: number; seat_limit: number } | undefined;
        if (!r) return null;
        return { "target.id": r.id, "target.purchasable": r.purchasable === 1, "target.seatLimit": r.seat_limit };
      },
    },
    {
      name: "invoices.pending",
      async read(a) {
        const r = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE subscription_id = ? AND status = 'pending'").get(a.sub) as { n: number };
        return { "billing.pendingInvoices": r.n };
      },
    },
    {
      name: "history.period",
      async read(a) {
        const r = db.prepare("SELECT COUNT(*) AS n FROM plan_change_history WHERE subscription_id = ? AND changed_at >= ?").get(a.sub, a.since) as { n: number };
        return { "history.changesThisPeriod": r.n };
      },
    },
    {
      name: "change.compute",
      async read(a) {
        const r = db.prepare(CHANGE_SQL).get(a.to, a.sub) as Parameters<typeof changeFacts>[0] | undefined;
        if (!r) return null;
        const f = changeFacts(r, now(), Number(a.threshold));
        return { "change.direction": f.direction, "change.prorationCents": f.prorationCents, "change.kind": f.kind };
      },
    },
  ];
}

export const applyAdapter: EffectAdapter = {
  tool: "plan.change.apply",
  apply(db, a, binding, { effectId, now }) {
    const iso = new Date(now).toISOString();
    const expected = Number(a.expectedVersion);
    const u = db.prepare("UPDATE subscriptions SET plan_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(a.toPlanId, iso, a.subscriptionId, expected);
    if (u.changes !== 1) throw new EffectRefusal("STALE_STATE", "subscription modified concurrently", "version_conflict");
    const p = Number(a.prorationCents);
    const desc = `Proration ${a.fromPlanId} -> ${a.toPlanId}`;
    if (p > 0) db.prepare("INSERT INTO invoice_items (id, subscription_id, invoice_id, amount_cents, description, created_at) VALUES (?, ?, NULL, ?, ?, ?)").run(`${effectId}_ii`, a.subscriptionId, p, desc, iso);
    else if (p < 0) db.prepare("INSERT INTO credit_notes (id, subscription_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(`${effectId}_cn`, a.subscriptionId, -p, desc, iso);
    db.prepare("INSERT INTO plan_change_history (id, subscription_id, from_plan_id, to_plan_id, direction, proration_cents, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(`${effectId}_h`, a.subscriptionId, a.fromPlanId, a.toPlanId, a.direction, p, a.changedBy, iso);
    const version = expected + 1;
    return {
      result: { status: "changed", subscriptionId: a.subscriptionId, fromPlanId: a.fromPlanId, toPlanId: a.toPlanId, direction: a.direction, prorationCents: p, version },
      outbox: [{ destination: "billing", payload: event(a, version, now) }],
    };
  },
};

export const approvalAdapter: EffectAdapter = {
  tool: "plan.change.requestApproval",
  apply(db, a, _binding, { effectId, now }) {
    db.prepare("INSERT INTO plan_change_requests (id, subscription_id, from_plan_id, to_plan_id, proration_cents, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)").run(effectId, a.subscriptionId, a.fromPlanId, a.toPlanId, a.prorationCents, a.requestedBy, new Date(now).toISOString());
    return { result: { status: "pending_approval", subscriptionId: a.subscriptionId, approvalRequestId: effectId, fromPlanId: a.fromPlanId, toPlanId: a.toPlanId, direction: "upgrade", prorationCents: Number(a.prorationCents) } };
  },
};

/** service.ts:254 notifyPlanChanged, now via the outbox (after commit, at-least-once, idempotency key). */
export function billing(baseUrl: string, doFetch: typeof fetch = fetch): Destination {
  return {
    name: "billing",
    secrets: ["billing.apiKey"], // resolved per send from the secret store (MN_SECRET_BILLING_APIKEY)
    async send(p, { secrets }) {
      const apiKey = secrets["billing.apiKey"];
      const r = await doFetch(`${baseUrl}/v1/subscriptions/${encodeURIComponent(String(p.subscriptionId))}/plan-changed`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "idempotency-key": `${p.subscriptionId}:${p.version}` },
        body: JSON.stringify(p),
      });
      if (!r.ok) throw Object.assign(new Error(`billing provider responded ${r.status}`), { retryable: r.status >= 500 });
      return { externalId: `${p.subscriptionId}:${p.version}` };
    },
  };
}
