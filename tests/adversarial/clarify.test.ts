/**
 * CLARIFY: ask the caller, persist the pending operation, resume with every check re-run.
 * Clarification must never authorize by itself; it may only add the caller's own words.
 */
import { dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONTRACT_PATH, buildRefundApp } from "@modelnativ/example-refund-migrated";
import { loadContract } from "@modelnativ/contract-compiler";
import { ScriptedModel, type AskInput, type ModelInput } from "@modelnativ/model-adapter";
import { createServer, testEnv } from "@modelnativ/runtime";
import { createModelnativ } from "@modelnativ/core";
import { alice, effectsState } from "../helpers.ts";

const opts = { readTools: ["orders.get", "carrier.status"], effectTools: ["payments.refund"] };
const CLARIFY = loadContract(join(dirname(CONTRACT_PATH), "refund.create.clarify.yaml"), opts);
const INTENT2 = loadContract(join(dirname(CONTRACT_PATH), "refund.create.intent2.yaml"), opts);

/**
 * A deterministic stand-in classifier: it reads the message AND any clarification. Explicit
 * phrases establish intent; anything else is "ambiguous" (which the intent policy routes on).
 */
const PHRASES: [RegExp, string][] = [
  [/no longer want the item/i, "CHANGED_MIND"],
  [/arrived broken, damaged/i, "DAMAGED"],
  [/never arrived/i, "NOT_DELIVERED"],
];
function classify(input: ModelInput) {
  const text = [input.observations["request.message"], input.observations["request.clarification"]].filter(Boolean).join("\n");
  for (const [re, cat] of PHRASES) {
    const m = re.exec(text);
    if (m) return { cat, level: "explicit", evidence: m[0] };
  }
  return { cat: "CHANGED_MIND", level: "ambiguous", evidence: "" };
}
const model = () =>
  new ScriptedModel(
    (input) => {
      const c = classify(input);
      return {
        operation: input.operation,
        contractVersion: input.contractVersion,
        decision: "PROPOSE_EFFECT",
        category: c.cat,
        effects: [{ tool: "payments.refund", args: { orderId: { ref: "order.id" }, amountCents: { ref: "order.refundableCents" } } }],
        intent: { level: c.level, evidence: c.evidence },
      };
    },
    "mock:clarify",
    (q: AskInput) => {
      const negative = /damaged, broken, defective, missing/.test(q.question);
      const wants = /no longer want the item/i.test(q.text);
      const problem = /broken|exchange|never arrived/i.test(q.text);
      return negative ? (problem ? "yes" : "no") : wants ? "yes" : "no";
    },
  );

function app(contract = CLARIFY, m = model()) {
  const env = testEnv(4);
  return { ...buildRefundApp({ env, model: m, contract, seed: 4 }), env, m };
}
const vague = { orderId: "ord_a1", message: "not happy with this tbh" };

describe("CLARIFY outcome", () => {
  it("asks instead of reviewing, persists the pending operation, executes nothing, keeps the token secret", async () => {
    const a = app();
    const r = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0001" });
    expect(r).toMatchObject({ outcome: "CLARIFY", code: "INTENT_NOT_ESTABLISHED", httpStatus: 202 });
    expect(r.clarification!.choices.map((c) => c.id)).toEqual(["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "SOMETHING_ELSE"]);
    expect(effectsState(a.db).refunds).toBe(0);
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM mn_pending WHERE status='pending'").get()).toEqual({ n: 1 });
    const stored = JSON.stringify([a.db.prepare("SELECT * FROM mn_pending").all(), (a.audit as any).records, [...(a.traces as any).traces.values()]]);
    expect(stored).not.toContain(r.clarification!.token);
  });

  it("without a clarify section, the same request is a REVIEW (the workflow is optional)", async () => {
    const a = app(INTENT2);
    const r = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a1", message: "not happy with this tbh" }, idempotencyKey: "clr-key-0002" });
    expect(r.outcome).toBe("REVIEW");
  });

  it("policy refusals and fact-based reviews are never turned into questions", async () => {
    const a = app();
    const old = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a3", message: "I no longer want the item, and nothing is wrong with it" }, idempotencyKey: "clr-key-0003" });
    expect(old).toMatchObject({ outcome: "REFUSE", code: "INVARIANT_VIOLATION" });
    const dmg = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a6", message: "The item arrived broken, damaged" }, idempotencyKey: "clr-key-0004" });
    expect(dmg).toMatchObject({ outcome: "REVIEW", code: "UNESTABLISHED_REQUIREMENT" }); // carrier fact missing: not the caller's to establish
  });
});

describe("resume re-runs every check", () => {
  it("a clear answer lets the full pipeline decide: ALLOW with one effect", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0010" });
    const r = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    expect(r.outcome).toBe("ALLOW");
    expect(effectsState(a.db).refunds).toBe(1);
    expect(a.m.calls).toBe(2); // the model re-proposed on the clarified input
  });
  it("clarification never authorizes by itself: ineligible orders are still refused, missing facts still reviewed", async () => {
    const a = app();
    const c1 = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a3", message: "meh" }, idempotencyKey: "clr-key-0011" });
    const r1 = await a.engine.resume({ principal: alice(a.env), token: c1.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    expect(r1).toMatchObject({ outcome: "REFUSE", code: "INVARIANT_VIOLATION" }); // 40 days old
    const c2 = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a6", message: "meh" }, idempotencyKey: "clr-key-0012" });
    const r2 = await a.engine.resume({ principal: alice(a.env), token: c2.clarification!.token, answer: { choice: "DAMAGED" } });
    expect(r2).toMatchObject({ outcome: "REVIEW", code: "UNESTABLISHED_REQUIREMENT" }); // the caller cannot establish carrier damage
    expect(effectsState(a.db).refunds).toBe(0);
  });
  it("an answer contradicting the original message is caught by the confirmation (no laundering)", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_a1", message: "can I exchange it for the bigger size" }, idempotencyKey: "clr-key-0013" });
    const r = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    expect(r).toMatchObject({ outcome: "REVIEW", code: "INTENT_UNCONFIRMED" }); // "exchange" in the combined text
    expect(effectsState(a.db).refunds).toBe(0);
  });
  it("a still-unclear answer ends in REVIEW after maxRounds, not an endless loop", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0014" });
    const r = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "SOMETHING_ELSE", text: "just not happy" } });
    expect(r.outcome).toBe("REVIEW");
  });
  it("resuming is equivalent to having said it upfront (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("ord_a1", "ord_a2", "ord_a3", "ord_a4", "ord_a6", "ord_big", "ord_b1"),
        fc.constantFrom("DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "SOMETHING_ELSE"),
        fc.option(fc.constantFrom("it is broken", "please", "exchange?", "never came"), { nil: undefined }),
        async (orderId, choice, text) => {
          const a = app();
          const p = alice(a.env);
          const c = await a.engine.handle({ principal: p, body: { orderId, message: "meh" }, idempotencyKey: "eqv-key-0001" });
          if (c.outcome !== "CLARIFY") return;
          const resumed = await a.engine.resume({ principal: p, token: c.clarification!.token, answer: { choice, ...(text ? { text } : {}) } });
          const said = [a.engine["clarifyChoices"]().find((x: { id: string }) => x.id === choice)!.text, text].filter(Boolean).join(". ");
          const b = app();
          const direct = await b.engine.handle({ principal: alice(b.env), body: { orderId, message: "meh", clarification: said }, idempotencyKey: "eqv-key-0001" });
          expect([resumed.outcome, resumed.code, resumed.effect?.result.amountCents]).toEqual([direct.outcome === "CLARIFY" ? "REVIEW" : direct.outcome, direct.code, direct.effect?.result.amountCents]);
        },
      ),
      { numRuns: 60, seed: 3 },
    );
  });
});

describe("resume safety", () => {
  it("a token is single-use (no replay)", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0020" });
    await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    const again = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    expect(again.code).toBe("CLARIFICATION_INVALID");
    expect(effectsState(a.db).refunds).toBe(1);
  });
  it("another principal or tenant cannot continue it, and the owner still can", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0021" });
    const t = c.clarification!.token;
    expect((await a.engine.resume({ principal: alice(a.env, { subject: "u_bob" }), token: t, answer: { choice: "CHANGED_MIND" } })).code).toBe("CLARIFICATION_INVALID");
    expect((await a.engine.resume({ principal: alice(a.env, { tenant: "t_globex" }), token: t, answer: { choice: "CHANGED_MIND" } })).code).toBe("CLARIFICATION_INVALID");
    expect((await a.engine.resume({ principal: alice(a.env), token: t, answer: { choice: "CHANGED_MIND" } })).outcome).toBe("ALLOW");
  });
  it("expired tokens and tokens from another contract version are invalid", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0022" });
    a.env.clock.advance(86_400_000 + 1);
    expect((await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } })).code).toBe("CLARIFICATION_INVALID");
    const b = app();
    const c2 = await b.engine.handle({ principal: alice(b.env), body: vague, idempotencyKey: "clr-key-0023" });
    b.db.prepare("UPDATE mn_pending SET contract_hash = 'older'").run(); // the contract changed since
    expect((await b.engine.resume({ principal: alice(b.env), token: c2.clarification!.token, answer: { choice: "CHANGED_MIND" } })).code).toBe("CLARIFICATION_INVALID");
  });
  it("a malformed answer is rejected without consuming the token", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0024" });
    expect((await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "REFUND_ME_NOW" } })).code).toBe("SCHEMA_INVALID");
    expect((await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } })).outcome).toBe("ALLOW");
  });
  it("two concurrent resumes: exactly one proceeds, one effect", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0025" });
    const rs = await Promise.all([1, 2].map(() => a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } })));
    expect(rs.map((r) => r.outcome).sort()).toEqual(["ALLOW", "REFUSE"]);
    expect(effectsState(a.db).refunds).toBe(1);
  });
  it("the resumed operation keeps the original idempotency identity: a retry of the original returns the same effect", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0026" });
    const r = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    const retry = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0026" });
    expect(retry).toMatchObject({ outcome: "ALLOW", effect: { status: "duplicate", effectId: r.effect!.effectId } });
    expect(effectsState(a.db).refunds).toBe(1);
  });
  it("state that changed while waiting is re-read: no stale execution", async () => {
    const a = app();
    const c = await a.engine.handle({ principal: alice(a.env), body: vague, idempotencyKey: "clr-key-0027" });
    a.db.prepare("UPDATE orders SET refundable_cents = 0, version = version + 1 WHERE id='ord_a1'").run(); // refunded elsewhere meanwhile
    const r = await a.engine.resume({ principal: alice(a.env), token: c.clarification!.token, answer: { choice: "CHANGED_MIND" } });
    expect(r).toMatchObject({ outcome: "REFUSE", code: "INVARIANT_VIOLATION" });
    expect(effectsState(a.db).refunds).toBe(0);
  });
});

describe("standalone HTTP and embedded SDK", () => {
  it("POST /v1/<op>/resume", async () => {
    const a = app();
    const server = createServer([a.engine], a.identity).listen(0);
    const port = (server.address() as { port: number }).port;
    const tok = a.identity.issue({ subject: "u_alice", tenant: "t_acme", sessionId: "s", scopes: ["refund:request"] });
    const post = (path: string, body: unknown, key?: string) =>
      fetch(`http://127.0.0.1:${port}/v1/refund.create${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    try {
      const c = await post("", vague, "http-clr-0001");
      expect(c).toMatchObject({ status: 202, body: { outcome: "CLARIFY" } });
      const r = await post("/resume", { token: c.body.clarification.token, answer: { choice: "CHANGED_MIND" } });
      expect(r).toMatchObject({ status: 201, body: { outcome: "ALLOW" } });
    } finally {
      server.close();
    }
  });
  it("mn.execute -> CLARIFY -> mn.resume", async () => {
    const a = app();
    const mn = createModelnativ([a.engine]);
    const c = await mn.execute("refund.create", vague, { principal: alice(a.env), idempotencyKey: "sdk-clr-0001" });
    expect(c.outcome).toBe("CLARIFY");
    const r = await mn.resume("refund.create", c.clarification!.token, { choice: "CHANGED_MIND" }, { principal: alice(a.env) });
    expect(r.outcome).toBe("ALLOW");
  });
});
