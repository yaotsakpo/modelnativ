import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CONTRACT_PATH } from "@modelnativ/example-refund-migrated";
import { compileContract, ContractError, evaluate, parseExpr, ExprError } from "../src/index.ts";

const base = () => YAML.parse(readFileSync(CONTRACT_PATH, "utf8"));
const opts = { readTools: ["orders.get", "carrier.status"], effectTools: ["payments.refund"] };

function rejects(mutate: (c: any) => void, match: RegExp) {
  const c = base();
  mutate(c);
  try {
    compileContract(c, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(ContractError);
    expect((e as ContractError).problems.join("\n")).toMatch(match);
    return;
  }
  throw new Error("contract was accepted");
}

describe("contract compiler", () => {
  it("compiles the refund contract and pins a hash", () => {
    const c = compileContract(base(), opts);
    expect(c.name).toBe("refund.create");
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(compileContract(base(), opts).hash).toBe(c.hash);
  });

  it("changes the hash when policy changes (30 -> 14 day window)", () => {
    const c = base();
    c.spec.decision.categories.CHANGED_MIND.requires = ["order.ageDays <= 14"];
    expect(compileContract(c, opts).hash).not.toBe(compileContract(base(), opts).hash);
  });

  it("rejects an unknown read tool", () => rejects((c) => (c.spec.facts[1].tool = "orders.scan"), /unknown read tool "orders.scan"/));
  it("rejects an unknown effect", () => rejects((c) => (c.spec.effects["payments.transfer"] = c.spec.effects["payments.refund"]), /unknown effect "payments.transfer"/));
  it("rejects an undefined policy variable", () => rejects((c) => c.spec.policy.invariants.push("proposal.amountCents <= order.creditLimit"), /undefined variable "order.creditLimit"/));
  it("rejects proposal variables in authorization rules", () => rejects((c) => c.spec.policy.authorization.push("proposal.amountCents > 0"), /undefined variable "proposal.amountCents"/));
  it("rejects code in an expression", () => rejects((c) => c.spec.policy.invariants.push("process.exit(1) == 1"), /invalid operand/));
  it("rejects prototype-shaped paths as undefined variables", () => rejects((c) => c.spec.policy.authorization.push("constructor.prototype == 1"), /undefined variable "constructor.prototype"/));
  it("rejects boolean composition tricks", () => rejects((c) => c.spec.policy.authorization.push("order.ownerId == principal.subject || true"), /expected/));
  it("rejects a fact no channel can establish", () => rejects((c) => (c.spec.authority = c.spec.authority.filter((g: any) => g.id !== "cap.carrier")), /shipment.damaged" comes from tool:carrier.status, which holds no grant/));
  it("rejects a bounded argument with no upper bound", () => rejects((c) => (c.spec.policy.invariants = ["proposal.amountCents > 0"]), /no invariant bounds it from above/));
  it("rejects an established argument without sources", () => rejects((c) => delete c.spec.effects["payments.refund"].args.orderId.from, /names no "from" facts/));
  it("rejects unsupported IR features instead of downgrading them", () => rejects((c) => (c.spec.policy.postconditions = ["order.refundableCents >= 0"]), /must NOT have additional properties/));
  it("rejects a category that can authorize with no requirement", () => rejects((c) => (c.spec.decision.categories.FREE = { description: "anything" }), /must require at least one fact/));
  it("rejects a concurrency key that is not a request fact", () => rejects((c) => (c.spec.concurrency.key = "order.id"), /must be a request fact/));
  it("rejects claims over predicates nobody provides", () => rejects((c) => c.spec.facts[0].claims.push("shipment.insured"), /claims "shipment.insured", which no source provides/));
});

describe("documentation-ready contracts", () => {
  it("rules may carry a human description, kept on the compiled expression", () => {
    const c = base();
    c.metadata.summary = "Refund a delivered order in the customer's own words";
    c.spec.policy.invariants = [
      "proposal.amountCents > 0",
      { rule: "proposal.amountCents <= order.refundableCents", description: "Never refund more than is left on the order" },
      { rule: "proposal.amountCents <= 50000", description: "Refunds above $500 need a human" },
    ];
    const k = compileContract(c, opts);
    expect(k.invariants[1]!.description).toBe("Never refund more than is left on the order");
    expect(k.invariants[0]!.description).toBeUndefined();
  });
  it("examples are validated against the input schema (docs cannot drift from the contract)", () => {
    const c = base();
    c.spec.examples = [
      { name: "changed mind", principal: { subject: "u_alice" }, request: { orderId: "ord_a1", message: "changed my mind" }, expect: { outcome: "ALLOW" } },
      { name: "too much", principal: { subject: "u_alice" }, request: { orderId: "ord_big", message: "refund $900" }, expect: { outcome: "REFUSE", code: "INVARIANT_VIOLATION" } },
    ];
    expect(() => compileContract(c, opts)).not.toThrow();
    c.spec.examples.push({ name: "stale doc", principal: { subject: "u_alice" }, request: { order: "ord_a1" }, expect: { outcome: "ALLOW" } });
    expect(() => compileContract(c, opts)).toThrow(/"stale doc" request does not satisfy spec.input/);
  });
  it("a rule object still goes through the expression grammar", () => rejects((c) => c.spec.policy.invariants.push({ rule: "process.exit(1) == 1", description: "x" }), /invalid operand/));
});

describe("expression language", () => {
  const r = (vals: Record<string, unknown>) => (p: string) => (p in vals ? { value: vals[p] } : undefined);
  it("evaluates comparisons", () => {
    expect(evaluate(parseExpr("a.b <= 30"), r({ "a.b": 30 })).status).toBe("true");
    expect(evaluate(parseExpr("a.b == 'x'"), r({ "a.b": "y" })).status).toBe("false");
  });
  it("reports unestablished paths instead of guessing", () => {
    expect(evaluate(parseExpr("a.b == true"), r({}))).toEqual({ status: "unestablished", paths: ["a.b"] });
  });
  it("never coerces types", () => {
    expect(evaluate(parseExpr("a.b <= 30"), r({ "a.b": "10" })).status).toBe("type_error");
    expect(evaluate(parseExpr("a.b == 1"), r({ "a.b": true })).status).toBe("type_error");
  });
  it("rejects anything outside the grammar", () => {
    for (const bad of ["a.b", "a.b === 1", "a.b <= 1 && c.d", "a[0] == 1", "x == 1"])
      expect(() => parseExpr(bad), bad).toThrow(ExprError);
  });
});
