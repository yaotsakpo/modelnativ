/**
 * Runtime reliability through the full kernel: rate limits, deadlines and cancellation,
 * transport retries (model and tools), circuit breaking, fair inference scheduling,
 * overload with Retry-After, durable dispatch, and replay of all of it.
 * Deterministic: VirtualClock + seeded randomness; `drive` advances virtual time only
 * when the program is idle.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CONTRACT_PATH, buildRefundApp } from "@modelnativ/example-refund-migrated";
import { compileContract } from "@modelnativ/contract-compiler";
import { ScriptedModel, type ModelAdapter, type ModelInput, type ModelOutput } from "@modelnativ/model-adapter";
import { FairScheduler, Limiter, RetryableError } from "@modelnativ/reliability";
import { FaultPlan, createServer, drive, replayTrace, testEnv } from "@modelnativ/runtime";
import { alice, effectsState, fullRefund, propose } from "../helpers.ts";

const opts = { readTools: ["orders.get", "carrier.status"], effectTools: ["payments.refund"] };
function contractWith(reliability: Record<string, unknown>, budget?: Record<string, unknown>) {
  const doc = YAML.parse(readFileSync(CONTRACT_PATH, "utf8"));
  doc.spec.reliability = reliability;
  if (budget) Object.assign(doc.spec.model.budget, budget);
  return compileContract(doc, opts);
}
const body = (i = 0) => ({ orderId: "ord_a1", message: `changed my mind ${i}` });
const ok = () => new ScriptedModel(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 10 } }));
const FAST_RETRY = { maxAttempts: 3, baseMs: 100, maxMs: 1000, jitter: "full" };

function app(model: ModelAdapter, reliability: Record<string, unknown> = {}, extra: Partial<Parameters<typeof buildRefundApp>[0]> = {}, budget?: Record<string, unknown>) {
  const { env: envOverrides, ...rest } = extra;
  const env = testEnv(9, envOverrides as never); // overrides (e.g. faults) merged INTO a full test env
  const a = buildRefundApp({ ...rest, env, model, contract: contractWith(reliability, budget), seed: 9 });
  return { ...a, env };
}

describe("rate limiting (runtime config)", () => {
  it("refuses with RATE_LIMITED + Retry-After before any inference, then admits after refill", async () => {
    const model = ok();
    const env = testEnv(1);
    const limiter = new Limiter([{ key: "tenant", capacity: 2, refillPerSec: 1 }], env.clock);
    const a = buildRefundApp({ env, model, limiter, contract: contractWith({}) });
    const p = alice(env);
    expect((await a.engine.handle({ principal: p, body: body(1), idempotencyKey: "rl-key-0001" })).outcome).toBe("ALLOW");
    expect((await a.engine.handle({ principal: p, body: body(2), idempotencyKey: "rl-key-0002" })).outcome).toBe("ALLOW");
    const r = await a.engine.handle({ principal: p, body: body(3), idempotencyKey: "rl-key-0003" });
    expect(r).toMatchObject({ outcome: "REFUSE", code: "RATE_LIMITED", httpStatus: 429, retryAfterMs: 1000 });
    expect(model.calls).toBe(2);
    env.clock.advance(1000);
    expect((await a.engine.handle({ principal: p, body: body(4), idempotencyKey: "rl-key-0004" })).outcome).toBe("ALLOW");
  });
  it("limits per principal, per operation and per API key independently", async () => {
    const env = testEnv(1);
    const limiter = new Limiter([{ key: "principal", capacity: 1, refillPerSec: 0.001 }, { key: "apiKey", capacity: 1, refillPerSec: 0.001 }], env.clock);
    const a = buildRefundApp({ env, model: ok(), limiter, contract: contractWith({}) });
    expect((await a.engine.handle({ principal: alice(env, { keyId: "k1" }), body: body(1), idempotencyKey: "rl2-key-001" })).outcome).toBe("ALLOW");
    expect((await a.engine.handle({ principal: alice(env, { keyId: "k2" }), body: body(2), idempotencyKey: "rl2-key-002" })).code).toBe("RATE_LIMITED"); // same principal
    const bob = alice(env, { subject: "u_bob", keyId: "k1" });
    expect((await a.engine.handle({ principal: bob, body: { orderId: "ord_b1", message: "x" }, idempotencyKey: "rl2-key-003" })).code).toBe("RATE_LIMITED"); // same key
  });
  it("sets the Retry-After header on HTTP 429", async () => {
    const env = testEnv(1);
    const limiter = new Limiter([{ key: "tenant", capacity: 1, refillPerSec: 0.5 }], env.clock);
    const a = buildRefundApp({ env, model: ok(), limiter, contract: contractWith({}) });
    const server = createServer([a.engine], a.identity).listen(0);
    const port = (server.address() as { port: number }).port;
    const tok = a.identity.issue({ subject: "u_alice", tenant: "t_acme", sessionId: "s", scopes: ["refund:request"] });
    const call = (k: string) => fetch(`http://127.0.0.1:${port}/v1/refund.create`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "idempotency-key": k }, body: JSON.stringify(body()) });
    try {
      expect((await call("http-rl-0001")).status).toBe(201);
      const r = await call("http-rl-0002");
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("2");
    } finally {
      server.close();
    }
  });
});

describe("model retries (transport failures only)", () => {
  it("retries a retryable adapter failure with backoff, then succeeds; replay reproduces the retries", async () => {
    let n = 0;
    const model = new ScriptedModel((i) => (++n < 3 ? new RetryableError("503 from inference server", true) : propose("CHANGED_MIND", fullRefund)(i)));
    const a = app(model, { model: { retry: FAST_RETRY } });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "mr-key-0001" }), a.env.clock);
    expect(r.outcome).toBe("ALLOW");
    expect(model.calls).toBe(3);
    const trace = a.traces.get(r.traceId)!;
    expect(trace.model.filter((m) => (m as { error?: string }).error)).toHaveLength(2);
    const rep = await replayTrace(trace, a.contract, ["orders.get", "carrier.status"]);
    expect(rep.diffs).toEqual([]);
    expect(rep.result).toEqual(r);
    // Same trace after a JSON round trip (what reading it back from disk does).
    const fromDisk = await replayTrace(JSON.parse(JSON.stringify(trace)), a.contract, ["orders.get", "carrier.status"]);
    expect(fromDisk.diffs).toEqual([]);
  });
  it("never retries a non-retryable adapter failure", async () => {
    const model = new ScriptedModel(() => new Error("model file corrupt"));
    const a = app(model, { model: { retry: FAST_RETRY } });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "mr-key-0002" }), a.env.clock);
    expect(r.code).toBe("MODEL_ERROR");
    expect(model.calls).toBe(1);
  });
  it("never retries a policy refusal", async () => {
    const model = new ScriptedModel(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 90000 } }));
    const a = app(model, { model: { retry: FAST_RETRY } });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: { orderId: "ord_big", message: "x" }, idempotencyKey: "mr-key-0003" }), a.env.clock);
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(model.calls).toBe(1);
    expect(effectsState(a.db).refunds).toBe(0);
  });
  it("a per-attempt timeout is retried and the slow inference is cancelled", async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const model: ModelAdapter = {
      id: "mock:slow-then-fast",
      propose(input: ModelInput, o: { signal?: AbortSignal }) {
        signals.push(o.signal!);
        if (++n === 1) return new Promise<ModelOutput>(() => {}); // hangs
        return Promise.resolve({ text: JSON.stringify(propose("CHANGED_MIND", fullRefund)(input)), modelId: "mock", promptTokens: 1, completionTokens: 1 });
      },
    };
    const a = app(model, { model: { retry: FAST_RETRY } }, {}, { timeoutMs: 500 });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "mr-key-0004" }), a.env.clock);
    expect(r.outcome).toBe("ALLOW");
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe("deadlines", () => {
  it("the request deadline cancels inference and refuses with DEADLINE_EXCEEDED", async () => {
    let seen: AbortSignal | undefined;
    const model: ModelAdapter = { id: "mock:hang", propose: (_i, o) => ((seen = o.signal), new Promise<ModelOutput>(() => {})) };
    const a = app(model, { deadlineMs: 2000, model: { retry: FAST_RETRY } });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "dl-key-0001" }), a.env.clock);
    expect(r).toMatchObject({ code: "DEADLINE_EXCEEDED", httpStatus: 504 });
    expect(seen!.aborted).toBe(true);
    expect(a.env.clock.now() - Date.UTC(2026, 10, 16, 12, 0, 0)).toBeLessThanOrEqual(2000);
    expect(effectsState(a.db).refunds).toBe(0);
  });
});

describe("tool retries", () => {
  it("retries transient read failures with backoff; replay reproduces them", async () => {
    const faults = new FaultPlan().arm("tool.orders.get", "network", 2);
    const a = app(ok(), { tools: { timeoutMs: 1000, retry: FAST_RETRY } }, { env: { faults } as never });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "tr-key-0001" }), a.env.clock);
    expect(r.outcome).toBe("ALLOW");
    expect(faults.hits).toHaveLength(2);
    const trace = a.traces.get(r.traceId)!;
    expect(trace.toolResults.filter((t) => (t as { error?: string }).error)).toHaveLength(2);
    const rep = await replayTrace(trace, a.contract, ["orders.get", "carrier.status"]);
    expect(rep.diffs).toEqual([]);
    const fromDisk = await replayTrace(JSON.parse(JSON.stringify(trace)), a.contract, ["orders.get", "carrier.status"]);
    expect(fromDisk.diffs).toEqual([]);
  });
  it("a non-transient read failure is not retried", async () => {
    const faults = new FaultPlan().arm("tool.orders.get", "db", 1);
    const a = app(ok(), { tools: { retry: FAST_RETRY } }, { env: { faults } as never });
    const r = await drive(a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "tr-key-0002" }), a.env.clock);
    expect(r.code).toBe("EXECUTION_FAILED");
    expect(faults.hits).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  it("opens after repeated model failures, fails fast with Retry-After, and recovers via a probe", async () => {
    let healthy = false;
    const model = new ScriptedModel((i) => (healthy ? propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 10 } })(i) : new RetryableError("down", true)));
    const a = app(model, { model: { breaker: { failures: 2, windowMs: 60_000, openMs: 30_000 } } });
    const go = (k: string) => drive(a.engine.handle({ principal: alice(a.env), body: body(Number(k.slice(-1))), idempotencyKey: k }), a.env.clock);
    expect((await go("cb-key-0001")).code).toBe("MODEL_ERROR");
    expect((await go("cb-key-0002")).code).toBe("MODEL_ERROR");
    const open = await go("cb-key-0003");
    expect(open).toMatchObject({ code: "MODEL_UNAVAILABLE", httpStatus: 503 });
    expect(open.retryAfterMs).toBeGreaterThan(0);
    expect(model.calls).toBe(2); // failed fast, no call
    healthy = true;
    a.env.clock.advance(30_000);
    expect((await go("cb-key-0004")).outcome).toBe("ALLOW"); // half-open probe succeeds -> closed
  });
});

describe("fair inference scheduling and overload", () => {
  it("one tenant's burst cannot starve another tenant", async () => {
    const env = testEnv(1);
    const scheduler = new FairScheduler({ maxConcurrent: 1, maxQueue: 100, maxQueuePerTenant: 50 }, env.clock);
    const slow: ModelAdapter = {
      id: "mock:slow",
      propose: async (input) => {
        await env.clock.sleep(100);
        return { text: JSON.stringify(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 1 } })(input)), modelId: "mock", promptTokens: 1, completionTokens: 1 };
      },
    };
    const a = buildRefundApp({ env, model: slow, scheduler, serialize: false, contract: contractWith({}) });
    const acme = Array.from({ length: 10 }, (_, i) => a.engine.handle({ principal: alice(env), body: { orderId: "ord_acct", message: `a${i}` }, idempotencyKey: `fair-a-${String(i).padStart(4, "0")}` }));
    const gina = { subject: "u_gina", tenant: "t_globex", sessionId: "g", scopes: ["refund:request"], expiresAt: env.clock.now() + 600_000 };
    const globex = a.engine.handle({ principal: gina, body: { orderId: "ord_g1", message: "g" }, idempotencyKey: "fair-g-0001" });
    await drive(Promise.all([...acme, globex]), env.clock);
    expect(scheduler.grants.indexOf("t_globex")).toBeLessThanOrEqual(2);
  });
  it("a full inference queue refuses with OVERLOADED and Retry-After instead of queueing forever", async () => {
    const env = testEnv(1);
    const scheduler = new FairScheduler({ maxConcurrent: 1, maxQueue: 1, maxQueuePerTenant: 1 }, env.clock);
    const hang: ModelAdapter = { id: "mock:hang", propose: () => new Promise<ModelOutput>(() => {}) };
    const a = buildRefundApp({ env, model: hang, scheduler, serialize: false, contract: contractWith({ deadlineMs: 60_000 }) });
    const go = (i: number) => a.engine.handle({ principal: alice(env), body: { orderId: "ord_acct", message: `o${i}` }, idempotencyKey: `ovl-key-${String(i).padStart(4, "0")}` });
    void go(1);
    void go(2);
    const r = await go(3);
    expect(r).toMatchObject({ code: "OVERLOADED", httpStatus: 429 });
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("durable dispatch", () => {
  it("permanent provider rejections are dead-lettered without retrying", async () => {
    const a = app(ok());
    await a.engine.handle({ principal: alice(a.env), body: body(), idempotencyKey: "dd-key-0001" });
    const dest = (a.dispatcher as unknown as { destinations: Map<string, { send: unknown }> }).destinations.get("psp")!;
    dest.send = async () => {
      throw Object.assign(new Error("400 invalid amount"), { retryable: false });
    };
    expect(await a.dispatcher.drain()).toMatchObject({ dead: 1, retried: 0 });
  });
  it("an open destination breaker defers delivery without spending attempts", async () => {
    const env = testEnv(3);
    const a = buildRefundApp({ env, model: ok(), contract: contractWith({}), dispatch: { breaker: { failures: 1, windowMs: 60_000, openMs: 10_000 } } });
    await a.engine.handle({ principal: alice(env), body: body(1), idempotencyKey: "dd-key-0002" });
    await a.engine.handle({ principal: alice(env, { subject: "u_bob" }), body: { orderId: "ord_b1", message: "x" }, idempotencyKey: "dd-key-0003" });
    a.psp.failNext = 1;
    const r = await a.dispatcher.drain();
    expect(r).toMatchObject({ retried: 1, deferred: 1 }); // the second message was not sent to a failing provider
    const rows = a.db.prepare("SELECT attempts FROM mn_outbox ORDER BY id").all() as { attempts: number }[];
    expect(rows.map((x) => x.attempts).sort()).toEqual([0, 1]);
  });
  it("jittered backoff is reproducible from the seed", async () => {
    const schedule = async (seed: number) => {
      const env = testEnv(seed);
      const a = buildRefundApp({ env, model: ok(), contract: contractWith({}), seed });
      await a.engine.handle({ principal: alice(env), body: body(), idempotencyKey: "dd-key-0004" });
      a.psp.failNext = 3;
      const at: number[] = [];
      for (let i = 0; i < 3; i++) {
        await a.dispatcher.drain();
        at.push((a.db.prepare("SELECT next_attempt_at AS t FROM mn_outbox").get() as { t: number }).t - env.clock.now());
        env.clock.advance(120_000);
      }
      return at;
    };
    expect(await schedule(5)).toEqual(await schedule(5));
    expect(await schedule(5)).not.toEqual(await schedule(6));
  });
});
