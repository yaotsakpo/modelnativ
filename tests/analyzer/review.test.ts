/**
 * `modelnativ review`: what it shows, where each statement's knowledge comes from, and that
 * primitive metadata matches what actually executed (observed manifest).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReview } from "@modelnativ/analyzer-typescript";
import { reviewApp } from "../../packages/cli/src/review-app.ts";

const ROOT = join(import.meta.dirname, "../..");
const C = {
  loyalty: ["examples/loyalty-original/modelnativ/c", "loyalty.redeem"],
  refund: ["examples/refund-original/modelnativ/c", "refund.request"],
  subscription: ["examples/subscription-original/modelnativ/c", "plan.change"],
} as const;

describe("modelnativ review", () => {
  it("loyalty (concise + primitives): rules in order with codes, derived values, writes, sends, unverified items", async () => {
    const r = await reviewApp(join(ROOT, C.loyalty[0]), C.loyalty[1]);
    const rules = ["acct.status == 'active'", "reward.id == request.rewardId", "acct.tierRank >= reward.minTierRank", "reward.stock >= request.quantity", "acct.points >= reward.totalCost", "today.count < policy.dailyLimit"];
    const pos = rules.map((x) => r.text.indexOf(x));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos); // evaluation order preserved
    expect(r.text).toMatch(/reward\.totalCost = .*Number\(r\.cost\)\s*\*\s*Number\(a\.quantity\).*\[verified\]/);
    expect(r.text).toMatch(/write\s+rewards: SET stock = stock - \?.*else INVARIANT_VIOLATION\/out_of_stock\s+\[verified; observed \d+×\]/);
    expect(r.text).toMatch(/SENDS\s+fulfillment .*at-least-once/);
    expect(r.json.unverified).toEqual(expect.arrayContaining([expect.stringContaining("acct.tierRank: uses TIER"), expect.stringContaining("idempotency policy not declared")]));
    expect(r.text.split("\n").length).toBeLessThan(60); // a one-screen default view
  });

  it("subscription: conditional writes, the hidden changeFacts() calculation, role set and config values", async () => {
    const r = await reviewApp(join(ROOT, C.subscription[0]), C.subscription[1]);
    expect(r.text).toMatch(/insert credit_notes .*only if .*<\s*0/);
    expect(r.text).toMatch(/member\.canChangePlan = .*r\.role\s*===\s*"admin"\s*\|\|\s*r\.role\s*===\s*"billing_manager"/);
    expect(r.text).toContain("policy.approvalThresholdCents = 25000");
    expect(r.json.unverified).toEqual(expect.arrayContaining([expect.stringContaining("uses changeFacts()")]));
  });

  it("refund: hybrid model use is disclosed with what the model sees, and its limits", async () => {
    const r = await reviewApp(join(ROOT, C.refund[0]), C.refund[1]);
    expect(r.text).toMatch(/MODEL\s+sees only: request\.message/);
    expect(r.json.unverified).toEqual(expect.arrayContaining([expect.stringContaining("model interpretation")]));
  });

  it("hand-written code is labelled [static], its derived values are NOT recovered, and it is listed as unverified", async () => {
    const r = await reviewApp(join(ROOT, "examples/loyalty-original/modelnativ"), "loyalty.redeem");
    expect(r.text).toMatch(/update rewards: SET stock = stock - \?.*\[static\]/);
    expect(r.text).not.toContain("reward.totalCost ="); // the calculation inside the hand-written tool is invisible
    expect(r.json.unverified).toEqual(expect.arrayContaining([expect.stringContaining("read tool rewards.get: hand-written"), expect.stringContaining("adapter loyalty.redeem.apply: hand-written")]));
  });

  it("verified metadata matches execution: every observed statement is in the metadata, and every step ran", async () => {
    for (const [dir, op] of Object.values(C)) {
      const r = await reviewApp(join(ROOT, dir), op);
      expect(r.text).not.toContain("observed only"); // nothing ran that the metadata does not show
      expect(r.text).not.toMatch(/observed NEVER/); // every declared step ran in the recorded cases
      const m = JSON.parse(readFileSync(join(ROOT, dir, "review", `${op}.observed.json`), "utf8"));
      expect(m.executions).toBeGreaterThan(800);
    }
  });

  it("a developer declaration is shown as UNVERIFIED, never as verified", () => {
    const contract = { metadata: { name: "x.op", version: 1 }, spec: { input: { properties: {} }, principal: { scopes: ["s"] }, tenancy: { key: "a.t" }, facts: [], decision: { categories: { X: { requires: [] } }, source: { mode: "fixed", category: "X" } }, policy: { authorization: [], invariants: [] }, effects: { "x.apply": { args: { a: { from: ["a.b"] } } } } } };
    const r = buildReview({
      contract, hash: "0".repeat(64), concise: false, explain: [], tools: [], destinations: [], observed: null, tests: [], transient: ["EXECUTION_FAILED"],
      adapters: [{ tool: "x.apply", declared: { writes: ["orders"] }, apply: function apply() {} }],
      runtime: { settleDefault: "release", retentionMs: 1, leaseMs: 1, waitMs: 1, maxWaiters: 1, outbox: { maxAttempts: 1, baseMs: 1, maxMs: 1, leaseMs: 1 } },
    });
    expect(r.text).toMatch(/declared: .*orders.*\[UNVERIFIED\]/);
    expect(r.text).not.toMatch(/orders.*\[verified/);
  });

  it("an observed manifest recorded against other code is STALE: flagged and not used as evidence", async () => {
    const dir = join(ROOT, C.loyalty[0]);
    const fresh = await reviewApp(dir, C.loyalty[1]);
    expect(fresh.text).toContain("observed 108×");
    const contract = { metadata: { name: "x.op", version: 1 }, spec: { input: { properties: {} }, principal: { scopes: ["s"] }, tenancy: { key: "a.t" }, facts: [], decision: { categories: { X: { requires: [] } }, source: { mode: "fixed", category: "X" } }, policy: { authorization: [], invariants: [] }, effects: { "x.apply": { args: { a: { from: ["a.b"] } } } } } };
    const r = buildReview({
      contract, hash: "0".repeat(64), concise: false, explain: [], tools: [], destinations: [], tests: [], transient: [],
      adapters: [{ tool: "x.apply", review: { kind: "sqlEffect", steps: [{ type: "insert", sql: "INSERT INTO t (a) VALUES (?)", params: "c=>[1]" }], result: "c=>({})" } }],
      observed: { fingerprint: "recorded-against-something-else", executions: 10, source: "x", effects: { "x.apply": { applied: 10, refused: {}, statements: [{ sql: "INSERT INTO t (a) VALUES (?)", count: 10 }], outbox: { gone: 10 } } } },
      runtime: { settleDefault: "release", retentionMs: 1, leaseMs: 1, waitMs: 1, maxWaiters: 1, outbox: { maxAttempts: 1, baseMs: 1, maxMs: 1, leaseMs: 1 } },
    });
    expect(r.json.unverified).toEqual(expect.arrayContaining([expect.stringContaining("observed manifest is STALE")]));
    expect(r.text).not.toContain("observed 10×");
    expect(r.text).not.toContain("gone"); // a destination only the stale manifest knew about is not reported
  });
});
