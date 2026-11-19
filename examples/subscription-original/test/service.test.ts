import { describe, expect, it } from "vitest";
import {
  addHistory,
  addPendingInvoice,
  admin,
  billingManager,
  count,
  member,
  NOW,
  otherTenantAdmin,
  outsider,
  conventionalOnly,
  setup,
  subscriptionRow,
} from "./helpers.ts";

const flush = () => new Promise((r) => setImmediate(r));

describe("SubscriptionService.changePlan — access", () => {
  it("lets an admin change the plan", async () => {
    const { service } = setup();
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("lets a billing manager change the plan", async () => {
    const { service } = setup();
    const res = await service.changePlan(billingManager, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("forbids a plain member", async () => {
    const { service, db } = setup();
    expect(await service.changePlan(member, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "forbidden",
    });
    expect(subscriptionRow(db).plan_id).toBe("plan_pro");
  });

  it("forbids a same-tenant user with no membership on the account", async () => {
    const { service } = setup();
    const res = await service.changePlan(outsider, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "forbidden" });
  });

  it("reports another tenant's subscription as not_found", async () => {
    const { service, db } = setup();
    const res = await service.changePlan(otherTenantAdmin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "not_found" });
    expect(subscriptionRow(db).plan_id).toBe("plan_pro");
  });

  it("reports a missing subscription as not_found", async () => {
    const { service } = setup();
    const res = await service.changePlan(admin, { subscriptionId: "sub_nope", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "not_found" });
  });
});

describe("SubscriptionService.changePlan — business rules", () => {
  it("rejects a past_due subscription", async () => {
    const { service } = setup({ status: "past_due" });
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "subscription_past_due",
    });
  });

  it("rejects a cancelled subscription", async () => {
    const { service } = setup({ status: "cancelled" });
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "subscription_cancelled",
    });
  });

  it("rejects an unknown target plan", async () => {
    const { service } = setup();
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_platinum" })).toEqual({
      status: "rejected",
      reason: "plan_not_found",
    });
  });

  it("rejects a plan that is no longer purchasable", async () => {
    const { service } = setup();
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_legacy" })).toEqual({
      status: "rejected",
      reason: "plan_not_purchasable",
    });
  });

  it("rejects changing to the current plan", async () => {
    const { service } = setup();
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" })).toEqual({
      status: "rejected",
      reason: "same_plan",
    });
  });

  it("rejects while an invoice is pending", async () => {
    const { service, db } = setup();
    addPendingInvoice(db);
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "invoice_pending",
    });
  });

  it("ignores paid invoices and other subscriptions' pending invoices", async () => {
    const { service, db } = setup();
    db.prepare("INSERT INTO invoices (id, subscription_id, status, amount_cents, created_at) VALUES ('inv_paid', 'sub_a', 'paid', 100, ?)").run(
      NOW.toISOString(),
    );
    addPendingInvoice(db, "sub_b");
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("enforces the per-period plan change cap", async () => {
    const { service, db } = setup({}, { maxPlanChangesPerPeriod: 2 });
    addHistory(db, "2026-03-02T00:00:00.000Z");
    addHistory(db, "2026-03-05T00:00:00.000Z");
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "plan_change_limit_reached",
    });
  });

  it("only counts changes made in the current billing period toward the cap", async () => {
    const { service, db } = setup({}, { maxPlanChangesPerPeriod: 1 });
    addHistory(db, "2026-02-20T00:00:00.000Z");
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("counts its own applied changes toward the cap", async () => {
    const { service } = setup({}, { maxPlanChangesPerPeriod: 1 });
    expect((await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).status).toBe("changed");
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" })).toEqual({
      status: "rejected",
      reason: "plan_change_limit_reached",
    });
  });

  it("blocks a downgrade while a promotional lock is active", async () => {
    const { service } = setup({ promoLockUntil: "2026-04-01T00:00:00.000Z" });
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "promo_lock_active",
    });
  });

  it("allows a downgrade once the promotional lock has expired", async () => {
    const { service } = setup({ promoLockUntil: "2026-03-10T00:00:00.000Z" });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("does not apply the promotional lock to upgrades", async () => {
    const { service } = setup({ planId: "plan_starter", promoLockUntil: "2026-04-01T00:00:00.000Z" });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" });
    expect(res.status).toBe("changed");
  });

  it("blocks a downgrade when seats in use exceed the new plan's limit", async () => {
    const { service } = setup({ seatsInUse: 6 });
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).toEqual({
      status: "rejected",
      reason: "seat_limit_exceeded",
    });
  });

  it("allows a downgrade when seats in use exactly equal the new limit", async () => {
    const { service } = setup({ seatsInUse: 5 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
  });

  it("treats an equal-price move to a lower feature tier as a downgrade", async () => {
    const { service, db } = setup({ seatsInUse: 3 });
    db.prepare("INSERT INTO plans (id, name, monthly_price_cents, seat_limit, feature_tier, purchasable) VALUES ('plan_pro_lite', 'Pro Lite', 9900, 2, 'starter', 1)").run();
    expect(await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro_lite" })).toEqual({
      status: "rejected",
      reason: "seat_limit_exceeded",
    });
  });
});

describe("SubscriptionService.changePlan — order of checks", () => {
  it("tenant isolation beats everything (other tenant + member-level failures + past_due)", async () => {
    const { service } = setup({ status: "past_due" });
    const res = await service.changePlan(otherTenantAdmin, { subscriptionId: "sub_a", targetPlanId: "plan_nope" });
    expect(res).toEqual({ status: "rejected", reason: "not_found" });
  });

  it("forbidden beats subscription state", async () => {
    const { service } = setup({ status: "cancelled" });
    const res = await service.changePlan(member, { subscriptionId: "sub_a", targetPlanId: "plan_nope" });
    expect(res).toEqual({ status: "rejected", reason: "forbidden" });
  });

  it("subscription state beats target plan validity", async () => {
    const { service } = setup({ status: "past_due" });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_nope" });
    expect(res).toEqual({ status: "rejected", reason: "subscription_past_due" });
  });

  it("plan_not_found beats invoice_pending", async () => {
    const { service, db } = setup();
    addPendingInvoice(db);
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_nope" });
    expect(res).toEqual({ status: "rejected", reason: "plan_not_found" });
  });

  it("plan_not_purchasable beats invoice_pending", async () => {
    const { service, db } = setup();
    addPendingInvoice(db);
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_legacy" });
    expect(res).toEqual({ status: "rejected", reason: "plan_not_purchasable" });
  });

  it("same_plan beats invoice_pending and the change cap", async () => {
    const { service, db } = setup({}, { maxPlanChangesPerPeriod: 0 });
    addPendingInvoice(db);
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" });
    expect(res).toEqual({ status: "rejected", reason: "same_plan" });
  });

  it("invoice_pending beats the change cap", async () => {
    const { service, db } = setup({}, { maxPlanChangesPerPeriod: 0 });
    addPendingInvoice(db);
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "invoice_pending" });
  });

  it("the change cap beats downgrade constraints", async () => {
    const { service } = setup({ promoLockUntil: "2026-04-01T00:00:00.000Z", seatsInUse: 50 }, { maxPlanChangesPerPeriod: 0 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "plan_change_limit_reached" });
  });

  it("promo_lock_active beats seat_limit_exceeded", async () => {
    const { service } = setup({ promoLockUntil: "2026-04-01T00:00:00.000Z", seatsInUse: 50 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toEqual({ status: "rejected", reason: "promo_lock_active" });
  });

  it("rejections leave no side effects and send no notification", async () => {
    const { service, db, billing } = setup({ seatsInUse: 50 });
    await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    await flush();
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_pro", version: 1 });
    expect(count(db, "invoice_items") + count(db, "credit_notes") + count(db, "plan_change_history") + count(db, "plan_change_requests")).toBe(0);
    expect(billing.events).toHaveLength(0);
  });
});

describe("SubscriptionService.changePlan — outcomes and effects", () => {
  it("applies an upgrade: bumps version, adds an invoice item, records history, notifies billing", async () => {
    const { service, db, billing } = setup({ planId: "plan_starter" });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" });
    expect(res).toEqual({
      status: "changed",
      subscriptionId: "sub_a",
      fromPlanId: "plan_starter",
      toPlanId: "plan_pro",
      direction: "upgrade",
      prorationCents: 4_667,
      version: 2,
    });
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_pro", version: 2 });
    expect(db.prepare("SELECT amount_cents, invoice_id FROM invoice_items").all()).toEqual([{ amount_cents: 4_667, invoice_id: null }]);
    expect(count(db, "credit_notes")).toBe(0);
    expect(db.prepare("SELECT from_plan_id, to_plan_id, direction, proration_cents, changed_by FROM plan_change_history").all()).toEqual([
      { from_plan_id: "plan_starter", to_plan_id: "plan_pro", direction: "upgrade", proration_cents: 4_667, changed_by: "user_admin" },
    ]);
    await flush();
    expect(billing.events).toEqual([
      {
        subscriptionId: "sub_a",
        accountId: "acct_a",
        fromPlanId: "plan_starter",
        toPlanId: "plan_pro",
        direction: "upgrade",
        prorationCents: 4_667,
        version: 2,
        changedAt: NOW.toISOString(),
      },
    ]);
  });

  it("applies a downgrade with a credit note", async () => {
    const { service, db } = setup();
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toMatchObject({ status: "changed", direction: "downgrade", prorationCents: -4_667 });
    expect(db.prepare("SELECT amount_cents FROM credit_notes").all()).toEqual([{ amount_cents: 4_667 }]);
    expect(count(db, "invoice_items")).toBe(0);
  });

  it("writes neither invoice item nor credit note when proration is zero (period over)", async () => {
    const { service, db } = setup({ periodEnd: "2026-03-11T00:00:00.000Z" });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res).toMatchObject({ status: "changed", prorationCents: 0 });
    expect(count(db, "invoice_items") + count(db, "credit_notes")).toBe(0);
    expect(count(db, "plan_change_history")).toBe(1);
  });

  it("requires approval for an upgrade whose charge exceeds the threshold, without applying it", async () => {
    const { service, db, billing } = setup({}, { approvalThresholdCents: 25_000 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_business" });
    // 40000 * 20/30 = 26666.67 -> 26667
    expect(res).toMatchObject({ status: "pending_approval", prorationCents: 26_667, fromPlanId: "plan_pro", toPlanId: "plan_business" });
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_pro", version: 1 });
    expect(count(db, "invoice_items") + count(db, "plan_change_history")).toBe(0);
    expect(db.prepare("SELECT status, proration_cents, requested_by FROM plan_change_requests").all()).toEqual([
      { status: "pending", proration_cents: 26_667, requested_by: "user_admin" },
    ]);
    await flush();
    expect(billing.events).toHaveLength(0);
  });

  it("applies an upgrade whose charge equals the threshold exactly", async () => {
    const { service } = setup({}, { approvalThresholdCents: 26_667 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_business" });
    expect(res).toMatchObject({ status: "changed", prorationCents: 26_667 });
  });

  it("never requires approval for downgrades, however large the credit", async () => {
    const { service } = setup({ planId: "plan_enterprise" }, { approvalThresholdCents: 0 });
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" });
    expect(res).toMatchObject({ status: "changed", direction: "downgrade" });
  });

  conventionalOnly("Modelnativ delivers the notification through the outbox and retries it; it does not log-and-drop")("does not fail the request when the billing notification fails", async () => {
    const { service, billing, logger, db } = setup();
    billing.fail = true;
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
    await flush();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(subscriptionRow(db).plan_id).toBe("plan_starter");
  });
});

describe("SubscriptionService.changePlan — concurrency and atomicity", () => {
  it("rejects with version_conflict when the expected version is stale", async () => {
    const { service, db, billing } = setup();
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter", expectedVersion: 7 });
    expect(res).toEqual({ status: "rejected", reason: "version_conflict" });
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_pro", version: 1 });
    expect(count(db, "credit_notes") + count(db, "plan_change_history")).toBe(0);
    await flush();
    expect(billing.events).toHaveLength(0);
  });

  it("detects a concurrent writer that bumped the version after the client read it", async () => {
    const { service, db } = setup();
    const seen = subscriptionRow(db).version;
    // Someone else changes the subscription in between.
    expect((await service.changePlan(billingManager, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).status).toBe("changed");
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro", expectedVersion: seen });
    expect(res).toEqual({ status: "rejected", reason: "version_conflict" });
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_starter", version: 2 });
  });

  it("accepts a matching expected version", async () => {
    const { service } = setup();
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter", expectedVersion: 1 });
    expect(res).toMatchObject({ status: "changed", version: 2 });
  });

  it("rolls back the subscription update and proration line if recording history fails", async () => {
    const { service, db, billing } = setup({ planId: "plan_starter" });
    db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON plan_change_history BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;`);
    await expect(service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_pro" })).rejects.toThrow("history unavailable");
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_starter", version: 1 });
    expect(count(db, "invoice_items")).toBe(0);
    expect(count(db, "plan_change_history")).toBe(0);
    await flush();
    expect(billing.events).toHaveLength(0);
  });

  it("rolls back the subscription update if writing the credit note fails", async () => {
    const { service, db } = setup();
    db.exec(`CREATE TRIGGER fail_credit BEFORE INSERT ON credit_notes BEGIN SELECT RAISE(ABORT, 'ledger locked'); END;`);
    await expect(service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" })).rejects.toThrow("ledger locked");
    expect(subscriptionRow(db)).toEqual({ plan_id: "plan_pro", version: 1 });
    expect(count(db, "plan_change_history")).toBe(0);
  });
});
