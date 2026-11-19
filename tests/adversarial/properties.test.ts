/**
 * Property-based: proposals generated from the contract's own vocabulary
 * (categories, effects, fact names), mixed with garbage. For every generated
 * proposal, against every seeded order and principal:
 *
 *   P1  an effect commits only if the gate said ALLOW;
 *   P2  every committed refund satisfies the invariants against the state it was
 *       committed on, targets an order the principal owns in their tenant, and its
 *       category's requirements held on facts established by a channel with authority;
 *   P3  money is conserved: refunds + remaining balance == original total.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEED } from "@modelnativ/example-refund-migrated";
import type { ModelInput } from "@modelnativ/model-adapter";
import { alice, makeApp, scripted } from "../helpers.ts";

const PREDICATES = ["order.id", "order.refundableCents", "order.ageDays", "order.version", "request.orderId", "request.message", "shipment.damaged", "shipment.note", "order.ownerId"];
const argValue = fc.oneof(
  fc.record({ ref: fc.constantFrom(...PREDICATES) }),
  fc.record({ value: fc.oneof(fc.integer({ min: -100000, max: 200000 }), fc.constantFrom(...SEED.map((s) => s.id)), fc.string({ maxLength: 12 })) }),
);
const effect = fc.oneof(
  { weight: 8, arbitrary: fc.record({ tool: fc.constant("payments.refund"), args: fc.record({ orderId: argValue, amountCents: argValue }) }) },
  { weight: 1, arbitrary: fc.record({ tool: fc.constantFrom("payments.transfer", "orders.delete", "payments.refund "), args: fc.dictionary(fc.string({ maxLength: 8 }), argValue) }) },
);
// Near-valid: right envelope and shape; category, amount, references and literals vary.
const nearValid = fc.record({
  operation: fc.constant("refund.create"),
  contractVersion: fc.constant(1),
  decision: fc.constant("PROPOSE_EFFECT"),
  category: fc.constantFrom("DAMAGED", "NOT_DELIVERED", "CHANGED_MIND"),
  effects: fc.tuple(
    fc.record({
      tool: fc.constant("payments.refund"),
      args: fc.record({
        orderId: fc.oneof(fc.constant({ ref: "order.id" }), fc.record({ value: fc.constantFrom(...SEED.map((s) => s.id)) }), fc.constant({ ref: "request.orderId" })),
        amountCents: fc.oneof(fc.constant({ ref: "order.refundableCents" }), fc.record({ value: fc.integer({ min: -10, max: 100000 }) }), fc.record({ value: fc.integer({ min: 1, max: 5000 }) })),
      }),
    }),
  ),
});
const proposal = fc.oneof(
  { weight: 10, arbitrary: nearValid },
  {
    weight: 10,
    arbitrary: fc.record({
      operation: fc.constantFrom("refund.create", "refund.create", "refund.approve"),
      contractVersion: fc.constantFrom(1, 1, 1, 2),
      decision: fc.constantFrom("PROPOSE_EFFECT", "PROPOSE_EFFECT", "REFUSE", "REVIEW", "APPROVE"),
      category: fc.constantFrom("DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "OTHER", "ADMIN_OVERRIDE"),
      effects: fc.array(effect, { maxLength: 2 }),
    }),
  },
  { weight: 1, arbitrary: fc.anything() },
);
const request = fc.constantFrom(...SEED).chain((o) =>
  fc.record({
    orderId: fc.constant(o.id),
    // Mostly the real owner (so the interesting checks run), sometimes someone else.
    subject: fc.oneof({ weight: 4, arbitrary: fc.constant(o.owner) }, { weight: 1, arbitrary: fc.constantFrom("u_alice", "u_bob", "u_gina") }),
    tenant: fc.oneof({ weight: 4, arbitrary: fc.constant(o.tenant) }, { weight: 1, arbitrary: fc.constantFrom("t_acme", "t_globex") }),
    claims: fc.option(fc.record({ damaged: fc.boolean(), delivered: fc.boolean() }, { requiredKeys: [] }), { nil: undefined }),
  }),
);

const DAY = 86_400_000;

describe("properties over generated proposals", () => {
  it("P1-P3 hold for every generated proposal", async () => {
    const tally: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(proposal, request, async (prop, req) => {
        const app = makeApp(scripted((_i: ModelInput) => prop));
        const principal = alice(app.env, { subject: req.subject, tenant: req.tenant });
        const r = await app.engine.handle({
          principal,
          body: { orderId: req.orderId, message: "generated", ...(req.claims ? { claims: req.claims } : {}) },
          idempotencyKey: "prop-key-0001",
        });
        const refunds = app.db.prepare("SELECT order_id, amount_cents FROM refunds").all() as { order_id: string; amount_cents: number }[];
        const k = r.code ?? r.outcome;
        tally[k] = (tally[k] ?? 0) + 1;
        // P1
        if (r.outcome !== "ALLOW") expect(refunds).toEqual([]);
        // P2 + P3
        for (const rf of refunds) {
          const seed = SEED.find((s) => s.id === rf.order_id)!;
          expect(seed.owner).toBe(principal.subject);
          expect(seed.tenant).toBe(principal.tenant);
          expect(rf.amount_cents).toBeGreaterThan(0);
          expect(rf.amount_cents).toBeLessThanOrEqual(Math.min(50000, seed.totalCents));
          const cat = (prop as { category: string }).category;
          if (cat === "DAMAGED") expect(seed.damaged === true && seed.ageDays <= 60).toBe(true); // carrier, not the customer's claim
          if (cat === "NOT_DELIVERED") expect(seed.delivered === false && seed.ageDays <= 45).toBe(true);
          if (cat === "CHANGED_MIND") expect(seed.ageDays <= 30).toBe(true);
          expect(["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND"]).toContain(cat);
          const row = app.db.prepare("SELECT refundable_cents AS c FROM orders WHERE id=?").get(rf.order_id) as { c: number };
          expect(row.c + rf.amount_cents).toBe(seed.totalCents);
        }
        void DAY;
      }),
      { numRuns: 600, seed: 20261116 },
    );
    console.log("property outcome tally:", JSON.stringify(tally));
    // Not vacuous: generated proposals reach ALLOW and a spread of refusal codes.
    expect(tally.ALLOW ?? 0).toBeGreaterThan(20);
    expect(Object.keys(tally).length).toBeGreaterThan(6);
  });
});
