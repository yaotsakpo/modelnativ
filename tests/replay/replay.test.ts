/**
 * Deterministic replay, two kinds:
 *  - TRACE replay: one recorded operation re-run from its trace (recorded tool
 *    results and model output, same clock and id stream), no model, no database.
 *  - SEED replay: a whole scenario (including faults, crashes, retries) re-run
 *    from the same seed and fault plan produces an identical event history.
 */
import { describe, expect, it } from "vitest";
import { CryptoRandom, FaultPlan, ReplayDivergence, replayTrace } from "@modelnativ/runtime";
import { alice, fullRefund, makeApp, propose, scripted } from "../helpers.ts";

async function recordOne(setup: (app: ReturnType<typeof makeApp>) => void, body: Record<string, unknown>, model = scripted(propose("CHANGED_MIND", fullRefund)), principal?: (env: any) => any, faults?: FaultPlan) {
  const app = makeApp(model, { seed: 42, env: faults ? { faults } : {} });
  setup(app);
  const r = await app.engine.handle({ principal: principal ? principal(app.env) : alice(app.env), body, idempotencyKey: "replay-key-1" });
  return { app, r, trace: app.traces.get(r.traceId)! };
}
const TOOLS = ["orders.get", "carrier.status"];

describe("trace replay", () => {
  it("an authorization refusal replays identically, without a model", async () => {
    const { r, trace, app } = await recordOne(() => {}, { orderId: "ord_b1", message: "changed my mind" });
    expect(r.code).toBe("CAPABILITY_MISSING");
    const rep = await replayTrace(trace, app.contract, TOOLS);
    expect(rep.diffs).toEqual([]);
    expect(rep.result).toEqual(r);
  });

  it("a failed transaction (db fault inside the commit) replays identically", async () => {
    const { r, trace, app } = await recordOne(() => {}, { orderId: "ord_a1", message: "changed my mind" }, undefined, undefined, new FaultPlan().arm("executor.beforeCommit", "db"));
    expect(r.code).toBe("EXECUTION_FAILED");
    const rep = await replayTrace(trace, app.contract, TOOLS);
    expect(rep.identical).toBe(true);
    expect(rep.result).toEqual(r);
  });

  it("a stale-state retry (two attempts, two model calls) replays identically", async () => {
    let app!: ReturnType<typeof makeApp>;
    const model = scripted((i, n) => {
      if (n === 0) app.db.prepare("UPDATE orders SET refundable_cents = 5000, version = version + 1 WHERE id='ord_a1'").run();
      return propose("CHANGED_MIND", fullRefund)(i);
    });
    const rec = await recordOne((a) => (app = a), { orderId: "ord_a1", message: "changed my mind" }, model);
    expect(rec.trace.model).toHaveLength(2);
    expect(rec.trace.commits.map((c: any) => c.result.status ?? c.result.code)).toEqual(["refused", "committed"]);
    const rep = await replayTrace(rec.trace, rec.app.contract, TOOLS);
    expect(rep.diffs).toEqual([]);
    expect(rep.result).toEqual(rec.r);
  });

  it("detects divergence: a tampered model output changes the bound effect", async () => {
    const { trace, app } = await recordOne(() => {}, { orderId: "ord_a1", message: "changed my mind" });
    const tampered = structuredClone(trace);
    const out = tampered.model[0]!.output as { text: string };
    out.text = out.text.replace('{"ref":"order.refundableCents"}', '{"value":1}');
    await expect(replayTrace(tampered, app.contract, TOOLS)).rejects.toThrow(ReplayDivergence);
  });

  it("replays a trace recorded with production (CSPRNG) ids", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { env: { random: new CryptoRandom() } });
    const r = await app.engine.handle({ principal: alice(app.env), body: { orderId: "ord_a1", message: "changed my mind" }, idempotencyKey: "replay-key-9" });
    expect(r.outcome).toBe("ALLOW");
    const rep = await replayTrace(app.traces.get(r.traceId)!, app.contract, TOOLS);
    expect(rep.diffs).toEqual([]);
    expect(rep.result).toEqual(r);
  });

  it("refuses to replay against a different contract", async () => {
    const { trace, app } = await recordOne(() => {}, { orderId: "ord_a1", message: "changed my mind" });
    await expect(replayTrace({ ...trace, contractHash: "0".repeat(64) }, app.contract, TOOLS)).rejects.toThrow(/contract hash differs/);
  });
});

describe("seed replay of whole scenarios", () => {
  async function crashAndRetryScenario(seed: number) {
    const faults = new FaultPlan().arm("outbox.afterSend", "crash").arm("executor.beforeCommit", "db");
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { seed, env: { faults } });
    const log: unknown[] = [];
    const p = alice(app.env);
    log.push(await app.engine.handle({ principal: p, body: { orderId: "ord_a1", message: "x" }, idempotencyKey: "scn-0001" })); // db fault
    log.push(await app.engine.handle({ principal: p, body: { orderId: "ord_a1", message: "x" }, idempotencyKey: "scn-0001" })); // retry ok
    log.push(await app.engine.handle({ principal: p, body: { orderId: "ord_a2", message: "it arrived broken" }, idempotencyKey: "scn-0002" }));
    app.psp.failNext = 1;
    for (let i = 0; i < 4; i++) {
      try {
        log.push(await app.dispatcher.drain());
      } catch (e) {
        log.push(`crash:${(e as Error).message}`);
      }
      app.env.clock.advance(1000);
    }
    log.push(app.db.prepare("SELECT * FROM mn_outbox ORDER BY id").all());
    log.push(app.db.prepare("SELECT * FROM refunds ORDER BY id").all());
    log.push([...app.psp.payments.entries()]);
    log.push((app.audit as any).records);
    return { log, faultsHit: faults.hits };
  }

  it("a worker crash plus retries produces a byte-identical history on every run", async () => {
    const a = await crashAndRetryScenario(7);
    const b = await crashAndRetryScenario(7);
    expect(a.faultsHit).toEqual(["executor.beforeCommit", "outbox.afterSend"]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const c = await crashAndRetryScenario(8); // a different seed changes ids, not outcomes
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });
});
