/** Shared subscription plan-change differential: the independent original vs any migrated app config. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionService, openDatabase, seed, type SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";
import { createApp, testEnv, type AppConfig } from "@modelnativ/runtime";
import type Database from "better-sqlite3";
import type { Observed } from "./harness.ts";

export const SUB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../examples/subscription-original/modelnativ");
const NOW = new Date("2026-03-11T00:00:00.000Z");

export type Case = {
  caller: { userId: string; tenantId: string };
  status: "active" | "past_due" | "cancelled";
  current: string;
  target: string;
  seats: number;
  promo: string | null;
  pendingInvoice: boolean;
  history: number;
  expectedVersion?: number;
};

function setup(db: Database.Database, c: Case) {
  seed(db, { now: NOW, status: c.status, planId: c.current, seatsInUse: c.seats, promoLockUntil: c.promo });
  // Equal-price pairs, so the "same price: compare feature tiers" rule is exercised:
  // plan_basic = Pro's price at a lower tier (a downgrade); plan_team = Business's price at a higher tier (an upgrade).
  const plan = db.prepare("INSERT INTO plans (id, name, monthly_price_cents, seat_limit, feature_tier, purchasable) VALUES (?, ?, ?, ?, ?, 1)");
  plan.run("plan_basic", "Basic", 9_900, 25, "starter");
  plan.run("plan_team", "Team", 49_900, 100, "enterprise");
  if (c.pendingInvoice) db.prepare("INSERT INTO invoices (id, subscription_id, status, amount_cents, created_at) VALUES ('inv_p', 'sub_a', 'pending', 1000, ?)").run(NOW.toISOString());
  for (let i = 0; i < c.history; i++)
    db.prepare("INSERT INTO plan_change_history (id, subscription_id, from_plan_id, to_plan_id, direction, proration_cents, changed_by, changed_at) VALUES (?, 'sub_a', 'plan_x', 'plan_y', 'upgrade', 0, 'user_admin', '2026-03-05T00:00:00.000Z')").run(`h${i}`);
}

function state(db: Database.Database) {
  return {
    subs: db.prepare("SELECT id, plan_id, version FROM subscriptions ORDER BY id").all(),
    items: db.prepare("SELECT subscription_id, amount_cents FROM invoice_items ORDER BY amount_cents").all(),
    credits: db.prepare("SELECT subscription_id, amount_cents FROM credit_notes ORDER BY amount_cents").all(),
    history: db.prepare("SELECT from_plan_id, to_plan_id, direction, proration_cents, changed_by FROM plan_change_history WHERE id NOT LIKE 'h%' ORDER BY from_plan_id").all(),
    requests: db.prepare("SELECT from_plan_id, to_plan_id, proration_cents, requested_by, status FROM plan_change_requests ORDER BY from_plan_id").all(),
  };
}

const req = (c: Case) => ({ subscriptionId: "sub_a", targetPlanId: c.target, ...(c.expectedVersion !== undefined ? { expectedVersion: c.expectedVersion } : {}) });

export async function runOriginal(c: Case, config: Partial<SubscriptionServiceConfig> = {}): Promise<Observed> {
  const db = openDatabase();
  setup(db, c);
  let calls = 0;
  const svc = new SubscriptionService({ db, now: () => NOW, billing: { notifyPlanChanged: async () => void calls++ }, logger: { warn() {} }, config });
  const r = await svc.changePlan(c.caller, req(c));
  await new Promise((res) => setImmediate(res));
  if (r.status === "rejected") return { outcome: "REFUSE", reason: r.reason, state: state(db), external: calls };
  return { outcome: "ALLOW", reason: r.status, amount: r.prorationCents, state: state(db), external: calls };
}

export async function runMigrated(c: Case, config: AppConfig, appDir: string): Promise<Observed> {
  const db = openDatabase();
  setup(db, c);
  const env = testEnv(1);
  env.clock.advance(NOW.getTime() - env.clock.now());
  let calls = 0;
  const fake = { name: "billing", secrets: [], send: async (p: Record<string, unknown>) => (calls++, { externalId: String(p.version) }) };
  const app = createApp({ ...config, destinations: () => [fake] }, appDir, { env, db });
  const principal = { subject: c.caller.userId, tenant: c.caller.tenantId, sessionId: "s", scopes: ["subscription:change-plan"], expiresAt: NOW.getTime() + 60_000 };
  const r = await app.engines[0]!.handle({ principal, body: req(c), idempotencyKey: "diff-key-0001" });
  await app.dispatcher.drain();
  if (r.outcome === "ALLOW") return { outcome: "ALLOW", reason: String(r.effect!.result.status), amount: Number(r.effect!.result.prorationCents), state: state(db), external: calls };
  return { outcome: r.outcome as Observed["outcome"], reason: r.reason ?? r.code, state: state(db), external: calls };
}

/** A seeded sample of the full grid (17,280 combinations), plus every caller x status x target at defaults. */
export function cases(n = 2500): Case[] {
  const callers = [
    { userId: "user_admin", tenantId: "tenant_a" },
    { userId: "user_billing", tenantId: "tenant_a" },
    { userId: "user_member", tenantId: "tenant_a" },
    { userId: "user_none", tenantId: "tenant_a" },
    { userId: "user_b_admin", tenantId: "tenant_b" },
  ];
  const grid = {
    caller: callers,
    status: ["active", "past_due", "cancelled"] as const,
    current: ["plan_starter", "plan_pro", "plan_business"],
    target: ["plan_starter", "plan_pro", "plan_business", "plan_enterprise", "plan_legacy", "plan_missing", "plan_basic", "plan_team"],
    seats: [3, 30],
    promo: [null, "2026-04-01T00:00:00.000Z"],
    pendingInvoice: [false, true],
    history: [0, 2],
    expectedVersion: [undefined, 1, 2],
  };
  let s = 20261117 >>> 0;
  const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 4294967296);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  /** Weighted pick, so permitted callers and active subscriptions (the paths with effects) get coverage. */
  const wpick = <T>(a: readonly T[], w: number[]) => {
    let x = rnd() * w.reduce((p, q) => p + q, 0);
    for (let i = 0; i < a.length; i++) if ((x -= w[i]!) < 0) return a[i]!;
    return a[a.length - 1]!;
  };
  const out: Case[] = [];
  for (const caller of callers) for (const status of grid.status) for (const target of grid.target) out.push({ caller, status, current: "plan_pro", target, seats: 3, promo: null, pendingInvoice: false, history: 0 });
  while (out.length < n)
    out.push({
      caller: wpick(grid.caller, [40, 30, 10, 10, 10]),
      status: wpick(grid.status, [80, 10, 10]),
      current: pick(grid.current),
      target: pick(grid.target),
      seats: pick(grid.seats),
      promo: pick(grid.promo),
      pendingInvoice: wpick(grid.pendingInvoice, [80, 20]),
      history: wpick(grid.history, [70, 30]),
      expectedVersion: wpick(grid.expectedVersion, [60, 25, 15]),
    });
  return out;
}
