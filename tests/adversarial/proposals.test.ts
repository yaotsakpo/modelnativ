/**
 * Adversarial proposals through the full kernel, with a scripted (mock) model
 * standing in for a compromised or confused one. Every case asserts the stable
 * code AND that no effect happened: no refund row, no effect record, no outbox
 * message, balances and versions unchanged.
 *
 * These results hold BY CONSTRUCTION (the gate is an allowlist by provenance and
 * invariants); this suite checks the code does what it says. It is not a
 * measurement of model behaviour; see bench/ for that.
 */
import { describe, expect, it } from "vitest";
import { HangingModel, ScriptedModel } from "@modelnativ/model-adapter";
import type { ReadTool } from "@modelnativ/runtime";
import { buildRefundApp, readTools } from "@modelnativ/example-refund-migrated";
import { alice, effectsState, fullRefund, makeApp, propose, scripted } from "../helpers.ts";

async function attempt(model: ScriptedModel | HangingModel, body: Record<string, unknown>, opts: Parameters<typeof makeApp>[1] & { principal?: any; key?: string | null } = {}) {
  const app = makeApp(model, opts);
  const before = effectsState(app.db);
  const principal = opts.principal === undefined ? alice(app.env) : typeof opts.principal === "function" ? opts.principal(app.env) : opts.principal;
  const r = await app.engine.handle({ principal, body, idempotencyKey: opts.key === undefined ? "idem-0001" : opts.key });
  return { r, app, before, after: effectsState(app.db) };
}

/** No effect happened, AND the gate refused before any commit was attempted (the adapter's
 *  in-transaction re-checks are a backstop and must not be what these tests observe). */
function noEffect(x: { before: unknown; after: unknown; r?: { traceId: string }; app?: { traces: { get(id: string): any } } }) {
  expect(x.after).toEqual(x.before);
  if (x.r && x.app) expect(x.app.traces.get(x.r.traceId).commits).toEqual([]);
}

describe("identity and scope (checked before any inference)", () => {
  it("unauthenticated: refused, model never called", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const x = await attempt(m, { orderId: "ord_a1", message: "changed my mind" }, { principal: null });
    expect(x.r.code).toBe("UNAUTHENTICATED");
    expect(m.calls).toBe(0);
    noEffect(x);
  });
  it("expired principal context: refused", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const x = await attempt(m, { orderId: "ord_a1", message: "x" }, { principal: (env: any) => alice(env, { expiresAt: env.clock.now() - 1 }) });
    expect(x.r.code).toBe("UNAUTHENTICATED");
    expect(m.calls).toBe(0);
    noEffect(x);
  });
  it("missing scope: refused, model never called", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const x = await attempt(m, { orderId: "ord_a1", message: "x" }, { principal: (env: any) => alice(env, { scopes: ["orders:read"] }) });
    expect(x.r.code).toBe("CAPABILITY_MISSING");
    expect(m.calls).toBe(0);
    noEffect(x);
  });
  it("a principal smuggled in the body is rejected by the input schema", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const x = await attempt(m, { orderId: "ord_b1", message: "x", principal: { subject: "u_bob" } });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    noEffect(x);
  });
  it("missing idempotency key: refused before inference", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const x = await attempt(m, { orderId: "ord_a1", message: "x" }, { key: null });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    expect(m.calls).toBe(0);
    noEffect(x);
  });
});

describe("malformed proposals", () => {
  it("not JSON: retried within budget, then refused", async () => {
    const m = scripted(() => "Sure! Here is your refund: {amount: lots}");
    const x = await attempt(m, { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    expect(m.calls).toBe(2); // maxRetries: 1
    noEffect(x);
  });
  it("self-asserted authority field (authorized: true): refused", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund, { authorized: true })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    noEffect(x);
  });
  it("amount as a string: refused", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: "100" } })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    noEffect(x);
  });
  it("two effects in one proposal: refused", async () => {
    const x = await attempt(
      scripted((i) => ({ ...propose("CHANGED_MIND", fullRefund)(i), effects: [{ tool: "payments.refund", args: fullRefund }, { tool: "payments.refund", args: fullRefund }] })),
      { orderId: "ord_a1", message: "x" },
    );
    expect(x.r.code).toBe("SCHEMA_INVALID");
    noEffect(x);
  });
  it("REFUSE carrying an effect: refused as ambiguous", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund, { decision: "REFUSE" })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("SCHEMA_INVALID");
    noEffect(x);
  });
  it("unknown effect tool: refused as UNSUPPORTED_EFFECT", async () => {
    const x = await attempt(scripted((i) => ({ ...propose("CHANGED_MIND", fullRefund)(i), effects: [{ tool: "payments.transfer", args: { to: "acct_evil" } }] })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("UNSUPPORTED_EFFECT");
    noEffect(x);
  });
  it("wrong contract version: refused", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund, { contractVersion: 2 })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("CONTRACT_VERSION_MISMATCH");
    noEffect(x);
  });
  it("output over the token budget: refused", async () => {
    const x = await attempt(scripted((i) => ({ ...propose("CHANGED_MIND", fullRefund)(i), category: "CHANGED_MIND", pad: "x".repeat(4000) })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("BUDGET_EXCEEDED");
    noEffect(x);
  });
});

describe("model failures fail closed", () => {
  it("timeout", async () => {
    const app = makeApp(new HangingModel());
    const before = effectsState(app.db);
    const p = app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_a1", message: "x" }, idempotencyKey: "idem-0001" });
    await new Promise((r) => setImmediate(r));
    app.env.clock.advance(8000);
    const r = await p;
    expect(r.code).toBe("MODEL_TIMEOUT");
    expect(effectsState(app.db)).toEqual(before);
  });
  it("adapter error", async () => {
    const x = await attempt(scripted(() => new Error("CUDA out of memory")), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("MODEL_ERROR");
    noEffect(x);
  });
});

describe("well-formed but out-of-policy proposals", () => {
  it("the $900 refund: well-formed JSON, blocked by the 50000-cent ceiling", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 90000 } })), { orderId: "ord_big", message: "refund me $900" });
    expect(x.r.code).toBe("INVARIANT_VIOLATION");
    expect(x.r.detail).toContain("proposal.amountCents <= 50000");
    noEffect(x);
  });
  it("more than the refundable balance", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 12001 } })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("INVARIANT_VIOLATION");
    noEffect(x);
  });
  it("zero and negative amounts", async () => {
    for (const v of [0, -500]) {
      const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: v } })), { orderId: "ord_a1", message: "x" });
      expect(x.r.code).toBe("INVARIANT_VIOLATION");
      noEffect(x);
    }
  });
  it("a lenient category for an old order (CHANGED_MIND at 40 days)", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund)), { orderId: "ord_a3", message: "it is broken" });
    expect(x.r.code).toBe("INVARIANT_VIOLATION");
    noEffect(x);
  });
});

describe("provenance: the model cannot originate consequential values", () => {
  it("a literal order id for someone else's order: UNESTABLISHED_VALUE", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { value: "ord_b1" }, amountCents: { value: 1000 } })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("UNESTABLISHED_VALUE");
    noEffect(x);
  });
  it("a reference to the wrong source (request.orderId instead of order.id)", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { ref: "request.orderId" }, amountCents: { value: 1000 } })), { orderId: "ord_a1", message: "x" });
    expect(x.r.code).toBe("UNESTABLISHED_VALUE");
    noEffect(x);
  });
  it("a literal that exactly equals the established value is accepted (exact-string provenance)", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", { orderId: { value: "ord_a1" }, amountCents: { value: 1000 } })), { orderId: "ord_a1", message: "x" });
    expect(x.r.outcome).toBe("ALLOW");
    expect(x.after.refunds).toBe(1);
  });
});

describe("authorization and tenancy", () => {
  it("someone else's order: CAPABILITY_MISSING", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund)), { orderId: "ord_b1", message: "changed my mind" });
    expect(x.r.code).toBe("CAPABILITY_MISSING");
    noEffect(x);
  });
  it("another tenant's order is invisible: refused as unverifiable", async () => {
    const x = await attempt(scripted(propose("CHANGED_MIND", fullRefund)), { orderId: "ord_g1", message: "changed my mind" });
    expect(x.r.code).toBe("UNVERIFIABLE_PRECONDITION");
    noEffect(x);
  });
  it("a buggy tool that leaks another tenant's order: TENANT_VIOLATION (defence in depth)", async () => {
    const leaky = (db: any, now: () => number): ReadTool[] =>
      readTools(db, now).map((t) =>
        t.name !== "orders.get"
          ? t
          : { name: t.name, read: (args) => t.read(args, { tenant: "t_globex" }) }, // ignores the caller's tenant
      );
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    const shared = buildRefundApp({ env: app.env, model: scripted(propose("CHANGED_MIND", fullRefund)), tools: leaky(app.db, () => app.env.clock.now()), seedOrders: false });
    const r = await shared.engine.handle({ principal: alice(app.env), body: { orderId: "ord_g1", message: "x" }, idempotencyKey: "idem-0001" });
    expect(r.code).toBe("TENANT_VIOLATION");
    expect(effectsState(app.db).refunds).toBe(0);
  });
});

describe("claims and injected content carry no authority", () => {
  it("the customer's own claim of damage is minted PROPOSING and goes to review", async () => {
    const x = await attempt(scripted(propose("DAMAGED", fullRefund)), { orderId: "ord_a6", message: "it arrived smashed", claims: { damaged: true } });
    expect(x.r.outcome).toBe("REVIEW");
    expect(x.r.code).toBe("UNESTABLISHED_REQUIREMENT");
    const audit = (x.app.audit as any).records[0];
    const claim = audit.evidence.find((e: any) => e.predicate === "shipment.damaged");
    expect(claim).toMatchObject({ class: "PROPOSING", via: "chan:principal-verified/u_alice" });
    noEffect(x);
  });
  it("the carrier's ESTABLISHING report defeats a contrary customer claim", async () => {
    const x = await attempt(scripted(propose("NOT_DELIVERED", fullRefund)), { orderId: "ord_a1", message: "never arrived", claims: { delivered: false } });
    expect(x.r.code).toBe("INVARIANT_VIOLATION"); // carrier says delivered == true
    noEffect(x);
  });
  it("a model that obeys an injected carrier note ($900, DAMAGED) produces no effect", async () => {
    const obeys = scripted(propose("DAMAGED", { orderId: { ref: "order.id" }, amountCents: { value: 90000 } }));
    const x = await attempt(obeys, { orderId: "ord_a5", message: "please refund" });
    expect(x.r.outcome).not.toBe("ALLOW");
    noEffect(x);
  });
  it("secrets never reach the model context", async () => {
    let seen = "";
    const spy = scripted((i) => ((seen = JSON.stringify(i)), propose("CHANGED_MIND", fullRefund)(i)));
    const x = await attempt(spy, { orderId: "ord_a1", message: "changed my mind" });
    expect(x.r.outcome).toBe("ALLOW");
    expect(seen).not.toContain("sk_test_psp_0001");
    expect(seen).not.toContain((x.app.secrets as { get(k: string): string }).get("ingress.signingKey"));
    // Minimisation: only model.sees facts carry values; the owner's identity never reaches the model.
    expect(Object.keys(JSON.parse(seen).observations).sort()).toEqual(["order.ageDays", "order.refundableCents", "request.message"]);
    expect(seen).not.toContain("u_alice");
  });
});
