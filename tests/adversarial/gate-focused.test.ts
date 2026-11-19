/**
 * Focused tests for three gate checks that mutation testing showed were each caught by a single
 * test: tenancy (M4), intent grounding (M7) and field re-derivation (M9). Each check is pinned
 * from several directions, at the gate level, so that disabling it fails several tests.
 */
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_PATH } from "@modelnativ/example-refund-migrated";
import { loadContract } from "@modelnativ/contract-compiler";
import { Evidence, evaluateProposal } from "@modelnativ/gate";
import { testEnv } from "@modelnativ/runtime";
import { alice } from "../helpers.ts";

const opts = { readTools: ["orders.get", "carrier.status"], effectTools: ["payments.refund"] };
const HYBRID = loadContract(CONTRACT_PATH, opts);
const INTENT = loadContract(join(dirname(CONTRACT_PATH), "refund.create.intent.yaml"), opts);
const env = testEnv(1);
const now = env.clock.now();
const ORDER = { "order.id": "ord_a1", "order.tenantId": "t_acme", "order.ownerId": "u_alice", "order.ageDays": 5, "order.refundableCents": 12000, "order.version": 1 };

function evidence(contract: typeof HYBRID, request: Record<string, unknown>, order: Record<string, unknown> = ORDER, carrier: Record<string, unknown> = {}) {
  const ev = new Evidence(contract, alice(env), "op_x", () => new Date(now));
  for (const [k, v] of Object.entries(request)) ev.record({ kind: "principal" }, `request.${k}`, v);
  for (const [k, v] of Object.entries(order)) ev.record({ kind: "tool", tool: "orders.get" }, k, v);
  for (const [k, v] of Object.entries(carrier)) ev.record({ kind: "tool", tool: "carrier.status" }, k, v);
  return ev;
}
const proposal = (category: string, intent?: Record<string, unknown>) => ({
  operation: "refund.create",
  contractVersion: 1,
  decision: "PROPOSE_EFFECT",
  category,
  effects: [{ tool: "payments.refund", args: { orderId: { ref: "order.id" }, amountCents: { ref: "order.refundableCents" } } }],
  ...(intent ? { intent } : {}),
});
const gate = (c: typeof HYBRID, ev: Evidence, p: unknown, source: "model" | "field" = "model") => evaluateProposal(c, alice(env), ev, p, now, { source });

describe("M4 tenancy: an established resource of another tenant is never acted on", () => {
  const foreign = { ...ORDER, "order.tenantId": "t_globex" };
  it("model-sourced proposal: TENANT_VIOLATION", () => {
    expect(gate(HYBRID, evidence(HYBRID, { orderId: "ord_a1", message: "changed my mind" }, foreign), proposal("CHANGED_MIND"))).toMatchObject({ outcome: "REFUSE", code: "TENANT_VIOLATION" });
  });
  it("field-sourced proposal: TENANT_VIOLATION (fact checks run before the structured category)", () => {
    expect(gate(HYBRID, evidence(HYBRID, { orderId: "ord_a1", reason: "NO_LONGER_WANTED" }, foreign), proposal("CHANGED_MIND"), "field")).toMatchObject({ outcome: "REFUSE", code: "TENANT_VIOLATION" });
  });
  it("tenancy precedes authorization: a foreign order owned by someone else is a tenant violation, not a permission error", () => {
    const r = gate(HYBRID, evidence(HYBRID, { orderId: "ord_a1", message: "changed my mind" }, { ...foreign, "order.ownerId": "u_mallory" }), proposal("CHANGED_MIND"));
    expect(r).toMatchObject({ outcome: "REFUSE", code: "TENANT_VIOLATION" });
  });
  it("the same order in the caller's tenant passes tenancy (control)", () => {
    const r = gate(HYBRID, evidence(HYBRID, { orderId: "ord_a1", message: "changed my mind" }), proposal("CHANGED_MIND"));
    expect(r.checks).toContain("tenancy:ok");
    expect(r.outcome).toBe("ALLOW");
  });
});

describe("M7 grounding: the model's quoted evidence must appear in the caller's own text", () => {
  const damaged = { "shipment.damaged": true };
  const run = (message: string, quote: string) => gate(INTENT, evidence(INTENT, { orderId: "ord_a1", message }, ORDER, damaged), proposal("DAMAGED", { level: "explicit", evidence: quote }));
  it("a quote found in the message (case and spacing normalised) is grounded", () => {
    expect(run("The box ARRIVED   crushed and broken", "arrived crushed and broken").outcome).toBe("ALLOW");
  });
  it("a quote that is not in the message is ungrounded", () => {
    expect(run("the box arrived late", "arrived crushed")).toMatchObject({ outcome: "REVIEW", code: "INTENT_UNGROUNDED" });
  });
  it("a quote shorter than 3 characters is ungrounded even if it occurs in the message", () => {
    expect(run("it is broken ok", "ok")).toMatchObject({ outcome: "REVIEW", code: "INTENT_UNGROUNDED" });
    expect(run("it is broken ok", "  ")).toMatchObject({ outcome: "REVIEW", code: "INTENT_UNGROUNDED" });
  });
  it("text from facts other than the declared source (e.g. a carrier note) does not ground a quote", () => {
    const ev = evidence(INTENT, { orderId: "ord_a1", message: "please refund" }, ORDER, { ...damaged, "shipment.note": "package crushed in transit" });
    expect(gate(INTENT, ev, proposal("DAMAGED", { level: "explicit", evidence: "package crushed" }))).toMatchObject({ outcome: "REVIEW", code: "INTENT_UNGROUNDED" });
  });
});

describe("M9 field re-derivation: a structured decision must match the caller's established field", () => {
  const ev = (reason?: string) => evidence(HYBRID, { orderId: "ord_a1", ...(reason ? { reason } : {}) }, ORDER, { "shipment.damaged": true, "shipment.delivered": false });
  it("each mismatched category is refused, for every structured value", () => {
    const map: Record<string, string> = { DAMAGED_ITEM: "DAMAGED", NEVER_ARRIVED: "NOT_DELIVERED", NO_LONGER_WANTED: "CHANGED_MIND" };
    for (const [reason, right] of Object.entries(map))
      for (const wrong of Object.values(map).filter((c) => c !== right))
        expect(gate(HYBRID, ev(reason), proposal(wrong), "field")).toMatchObject({ outcome: "REFUSE", code: "SCHEMA_INVALID" });
  });
  it("a field-sourced proposal without an established field is refused", () => {
    expect(gate(HYBRID, ev(), proposal("DAMAGED"), "field")).toMatchObject({ outcome: "REFUSE", code: "SCHEMA_INVALID" });
  });
  it("the matching category is not refused by re-derivation (control)", () => {
    expect((gate(HYBRID, ev("DAMAGED_ITEM"), proposal("DAMAGED"), "field") as { code?: string }).code).not.toBe("SCHEMA_INVALID");
  });
});
