/**
 * Concurrency (PRD §21.2 and the testing requirement): systematic exploration of
 * interleavings at the kernel's yield points (facts, model, gate, commit), not a
 * seeded run. Every schedule starts from fresh state.
 */
import { describe, expect, it } from "vitest";
import { ControlledScheduler, drive, exploreSchedules } from "@modelnativ/runtime";
import type { EffectAdapter } from "@modelnativ/effect-executor";
import { alice, makeApp, propose, scripted } from "../helpers.ts";

const eighty = () => scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 8000 } }));
const refundSum = (db: any) => (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE order_id='ord_acct'").get() as { s: number }).s;
const balance = (db: any) => (db.prepare("SELECT refundable_cents AS c FROM orders WHERE id='ord_acct'").get() as { c: number }).c;

async function twoWithdrawals(opts: { serialize: boolean; adapter?: EffectAdapter }) {
  const outcomes: string[][] = [];
  let staleSeen = 0;
  let violations = 0;
  const res = await exploreSchedules(async () => {
    const scheduler = new ControlledScheduler();
    const app = makeApp(eighty(), { env: { scheduler }, serialize: opts.serialize, adapter: opts.adapter });
    const go = (key: string) => () => app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_acct", message: "changed my mind" }, idempotencyKey: key });
    return {
      scheduler,
      tasks: { A: go("withdraw-A-0001"), B: go("withdraw-B-0001") },
      check: (r) => {
        expect(r.deadlock).toBe(false);
        const rs = Object.values(r.results) as any[];
        outcomes.push(rs.map((x) => (x.code ? `${x.outcome}:${x.code}` : x.outcome)).sort());
        const allowed = rs.filter((x) => x.outcome === "ALLOW").length;
        if (rs.some((x) => (app.audit as any).records.some((a: any) => a.operationId === x.operationId && a.attempts === 2))) staleSeen++;
        if (allowed > 1 || refundSum(app.db) > 10000 || balance(app.db) < 0) violations++;
      },
    };
  });
  return { ...res, outcomes, staleSeen, violations };
}

// Exhaustive exploration replays every schedule from fresh state; give it an explicit budget.
describe("two simultaneous $80 withdrawals from $100 (acceptance criterion)", { timeout: 60_000 }, () => {
  it("never both succeed, across every schedule, with the DB version check alone (actor off)", async () => {
    const r = await twoWithdrawals({ serialize: false });
    expect(r.exhaustive).toBe(true);
    expect(r.explored).toBeGreaterThan(10);
    expect(r.violations).toBe(0);
    expect(r.staleSeen).toBeGreaterThan(0); // the race was actually exercised, and resolved by re-deciding
    for (const o of r.outcomes) expect(o.filter((x) => x === "ALLOW")).toHaveLength(1);
  });

  it("never both succeed with per-resource actors on (the default)", async () => {
    const r = await twoWithdrawals({ serialize: true });
    expect(r.exhaustive).toBe(true);
    expect(r.violations).toBe(0);
    expect(r.staleSeen).toBe(0); // serialized: no stale reads at all
  });

  it("the explorer has teeth: an adapter without a version check double-spends in some schedule", async () => {
    const naive: EffectAdapter = {
      tool: "payments.refund",
      apply(db, args, b, { effectId, now }) {
        // BUG on purpose: no version check, clamps instead of refusing.
        db.prepare("UPDATE orders SET refundable_cents = MAX(refundable_cents - ?, 0), version = version + 1 WHERE id=?").run(args.amountCents, args.orderId);
        db.prepare("INSERT INTO refunds(id, tenant_id, order_id, amount_cents, created_at) VALUES (?,?,?,?,?)").run(effectId, b.tenant, args.orderId, args.amountCents, now);
        return { result: {} };
      },
    };
    const r = await twoWithdrawals({ serialize: false, adapter: naive });
    expect(r.violations).toBeGreaterThan(0);
  });
});

describe("load: concurrent requests against one resource", () => {
  it("1000 concurrent 50-cent refunds on a 10000-cent balance: exactly 200 succeed (actors on)", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 50 } })));
    const rs = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_acct", message: `n${i}` }, idempotencyKey: `load-${String(i).padStart(6, "0")}` }),
      ),
    );
    expect(rs.filter((r) => r.outcome === "ALLOW")).toHaveLength(200);
    expect(rs.filter((r) => r.outcome !== "ALLOW").every((r) => r.code === "INVARIANT_VIOLATION")).toBe(true);
    expect(balance(app.db)).toBe(0);
    expect(refundSum(app.db)).toBe(10000);
  });

  it("1000 concurrent requests with actors off: invariant holds, losers get explicit conflicts", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 50 } })), { serialize: false });
    const rs = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_acct", message: `n${i}` }, idempotencyKey: `load-${String(i).padStart(6, "0")}` }),
      ),
    );
    const ok = rs.filter((r) => r.outcome === "ALLOW").length;
    expect(refundSum(app.db)).toBe(ok * 50);
    expect(balance(app.db)).toBe(10000 - ok * 50);
    expect(rs.filter((r) => r.outcome !== "ALLOW").every((r) => ["STALE_STATE", "INVARIANT_VIOLATION"].includes(r.code!))).toBe(true);
  });

  it("100 concurrent retries of ONE idempotency key produce one effect", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 50 } })), { serialize: false });
    // Duplicates wait (on the virtual clock) for the owner's answer: drive the clock.
    const rs = await drive(
      Promise.all(Array.from({ length: 100 }, () => app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_acct", message: "same" }, idempotencyKey: "one-key-0001" }))),
      app.env.clock,
    );
    expect(refundSum(app.db)).toBe(50);
    expect(rs.filter((r) => r.outcome === "ALLOW" && r.effect?.status === "committed")).toHaveLength(1);
    // Every duplicate converges on that same effect (none sees a half-finished state).
    expect(new Set(rs.map((r) => r.effect?.effectId)).size).toBe(1);
  });

  it("admission control: a resource queue over its bound refuses with OVERLOADED", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 1 } })));
    const rs = await Promise.all(
      Array.from({ length: 2100 }, (_, i) =>
        app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_acct", message: "x" }, idempotencyKey: `adm-${String(i).padStart(6, "0")}` }),
      ),
    );
    expect(rs.filter((r) => r.code === "OVERLOADED")).toHaveLength(100);
  });
});
