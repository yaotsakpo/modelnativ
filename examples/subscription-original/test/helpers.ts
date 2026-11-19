import { it, vi } from "vitest";
import { openDatabase, seed, type Db, type SeedOptions } from "../src/schema.ts";
import { SubscriptionService, type Caller, type SubscriptionServiceConfig } from "../src/service.ts";
import type { BillingProvider, PlanChangedEvent } from "../src/billing-provider.ts";

/** Period is 2026-03-01..2026-03-31 (30 days); "now" is 2026-03-11, i.e. 20 of 30 days remain. */
export const NOW = new Date("2026-03-11T00:00:00.000Z");

export const admin: Caller = { userId: "user_admin", tenantId: "tenant_a" };
export const billingManager: Caller = { userId: "user_billing", tenantId: "tenant_a" };
export const member: Caller = { userId: "user_member", tenantId: "tenant_a" };
export const outsider: Caller = { userId: "user_nobody", tenantId: "tenant_a" };
export const otherTenantAdmin: Caller = { userId: "user_b_admin", tenantId: "tenant_b" };

export class FakeBilling implements BillingProvider {
  events: PlanChangedEvent[] = [];
  fail = false;
  async notifyPlanChanged(event: PlanChangedEvent): Promise<void> {
    this.events.push(event);
    if (this.fail) throw new Error("provider down");
  }
}

export interface Harness {
  db: Db;
  billing: FakeBilling;
  service: SubscriptionService;
  logger: { warn: ReturnType<typeof vi.fn> };
}

/**
 * Shared tests: these tests also run against the Modelnativ implementation
 * (tests/shared/subscription.modelnativ.test.ts installs its factory before importing them).
 * Without a factory, the conventional SubscriptionService is used.
 */
type ServiceFactory = (deps: ConstructorParameters<typeof SubscriptionService>[0]) => Pick<SubscriptionService, "changePlan">;
const g = globalThis as { __subscriptionServiceFactory?: ServiceFactory; __subscriptionImplementation?: string };
export const IMPLEMENTATION = g.__subscriptionImplementation ?? "conventional";

/** A test whose behaviour intentionally differs in the Modelnativ implementation (reason documented). */
export function conventionalOnly(reason: string) {
  void reason; // documented in examples/subscription-original/README.md
  return IMPLEMENTATION === "conventional" ? it : it.skip;
}

export function setup(seedOpts: SeedOptions = {}, config: Partial<SubscriptionServiceConfig> = {}): Harness {
  const db = openDatabase();
  seed(db, { now: NOW, ...seedOpts });
  const billing = new FakeBilling();
  const logger = { warn: vi.fn() };
  const deps = { db, billing, config, now: () => NOW, logger };
  const service = (g.__subscriptionServiceFactory ? g.__subscriptionServiceFactory(deps) : new SubscriptionService(deps)) as SubscriptionService;
  return { db, billing, service, logger };
}

export function addPendingInvoice(db: Db, subscriptionId = "sub_a"): void {
  db.prepare("INSERT INTO invoices (id, subscription_id, status, amount_cents, created_at) VALUES (?, ?, 'pending', 9900, ?)").run(
    `inv_${Math.random().toString(36).slice(2)}`,
    subscriptionId,
    NOW.toISOString(),
  );
}

export function addHistory(db: Db, changedAt: string, subscriptionId = "sub_a"): void {
  db.prepare(
    `INSERT INTO plan_change_history (id, subscription_id, from_plan_id, to_plan_id, direction, proration_cents, changed_by, changed_at)
     VALUES (?, ?, 'plan_starter', 'plan_pro', 'upgrade', 100, 'user_admin', ?)`,
  ).run(`hist_${Math.random().toString(36).slice(2)}`, subscriptionId, changedAt);
}

export function subscriptionRow(db: Db, id = "sub_a"): { plan_id: string; version: number } {
  return db.prepare("SELECT plan_id, version FROM subscriptions WHERE id = ?").get(id) as { plan_id: string; version: number };
}

export function count(db: Db, table: "invoice_items" | "credit_notes" | "plan_change_history" | "plan_change_requests"): number {
  const sql = {
    invoice_items: "SELECT COUNT(*) AS n FROM invoice_items",
    credit_notes: "SELECT COUNT(*) AS n FROM credit_notes",
    plan_change_history: "SELECT COUNT(*) AS n FROM plan_change_history",
    plan_change_requests: "SELECT COUNT(*) AS n FROM plan_change_requests",
  }[table];
  return (db.prepare(sql).get() as { n: number }).n;
}
