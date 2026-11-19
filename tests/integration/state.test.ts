import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_PATH } from "@modelnativ/example-refund-migrated";
import { FaultPlan, createServer } from "@modelnativ/runtime";
import { MemorySecretStore } from "@modelnativ/effect-executor";
import { alice, effectsState, fullRefund, makeApp, propose, scripted } from "../helpers.ts";

const body = { orderId: "ord_a1", message: "changed my mind" };
const bal = (db: any, id: string) => (db.prepare("SELECT refundable_cents AS c, version AS v FROM orders WHERE id=?").get(id) as { c: number; v: number });

describe("idempotency and replay", () => {
  it("a duplicate request never duplicates the refund, and costs no inference", async () => {
    const m = scripted(propose("CHANGED_MIND", fullRefund));
    const app = makeApp(m);
    const a = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-dup-1" });
    const b = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-dup-1" });
    expect(a.outcome).toBe("ALLOW");
    expect(b).toMatchObject({ outcome: "ALLOW", httpStatus: 200, effect: { status: "duplicate", effectId: a.effect!.effectId } });
    expect(m.calls).toBe(1);
    expect(effectsState(app.db).refunds).toBe(1);
  });
  it("the same key for a different request is REPLAY_DETECTED", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 100 } })));
    await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-dup-2" });
    const r = await app.engine.handle({ principal: alice(app.env), body: { ...body, message: "again" }, idempotencyKey: "idem-dup-2" });
    expect(r.code).toBe("REPLAY_DETECTED");
    expect(effectsState(app.db).refunds).toBe(1);
  });
  it("keys are scoped per principal: bob's key cannot collide with alice's", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    const a = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "shared-key-1" });
    const b = await app.engine.handle({ principal: alice(app.env, { subject: "u_bob" }), body: { orderId: "ord_b1", message: "changed my mind" }, idempotencyKey: "shared-key-1" });
    expect(a.outcome).toBe("ALLOW");
    expect(b.outcome).toBe("ALLOW");
    expect(effectsState(app.db).refunds).toBe(2);
  });
});

describe("stale state", () => {
  it("a concurrent write between decision and commit forces a fresh decision, never a replay of the old one", async () => {
    let app!: ReturnType<typeof makeApp>;
    const m = scripted((i, n) => {
      if (n === 0) app.db.prepare("UPDATE orders SET refundable_cents = 5000, version = version + 1 WHERE id='ord_a1'").run(); // someone else writes
      return propose("CHANGED_MIND", fullRefund)(i);
    });
    app = makeApp(m);
    const r = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-stale-1" });
    expect(m.calls).toBe(2);
    expect(r).toMatchObject({ outcome: "ALLOW", effect: { result: { amountCents: 5000, remainingCents: 0 } } });
  });
  it("state that keeps changing ends in STALE_STATE with no effect", async () => {
    let app!: ReturnType<typeof makeApp>;
    const m = scripted((i) => {
      app.db.prepare("UPDATE orders SET version = version + 1 WHERE id='ord_a1'").run();
      return propose("CHANGED_MIND", fullRefund)(i);
    });
    app = makeApp(m);
    const r = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-stale-2" });
    expect(r.code).toBe("STALE_STATE");
    expect(effectsState(app.db).refunds).toBe(0);
  });
});

describe("fault injection", () => {
  it("a database failure inside the commit rolls everything back; a retry then succeeds once", async () => {
    const faults = new FaultPlan().arm("executor.beforeCommit", "db");
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { env: { faults } });
    const before = effectsState(app.db);
    const r1 = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-fault-1" });
    expect(r1.code).toBe("EXECUTION_FAILED");
    expect(effectsState(app.db)).toEqual(before);
    const r2 = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-fault-1" });
    expect(r2.outcome).toBe("ALLOW");
    expect(effectsState(app.db).refunds).toBe(1);
  });
  it("a read tool network failure fails closed", async () => {
    const faults = new FaultPlan().arm("tool.orders.get", "network");
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { env: { faults } });
    const r = await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-fault-2" });
    expect(r.code).toBe("EXECUTION_FAILED");
    expect(effectsState(app.db).refunds).toBe(0);
  });
  it("worker crash after the provider accepted, before the ack: restart delivers once (idempotent receiver)", async () => {
    const faults = new FaultPlan().arm("outbox.afterSend", "crash");
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { env: { faults } });
    await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-crash-1" });
    await expect(app.dispatcher.drain()).rejects.toThrow(/crash/);
    expect(app.db.prepare("SELECT status FROM mn_outbox").get()).toEqual({ status: "pending" });
    const restarted = await app.dispatcher.drain(); // the "new process"
    expect(restarted.delivered).toBe(1);
    expect(app.psp.calls).toBe(2); // at-least-once dispatch...
    expect(app.psp.payments.size).toBe(1); // ...one effect at the receiver
  });
  it("provider outages are retried with exponential backoff, then dead-lettered", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-retry-1" });
    app.psp.failNext = 2;
    expect(await app.dispatcher.drain()).toEqual({ delivered: 0, retried: 1, dead: 0 });
    expect(await app.dispatcher.drain()).toEqual({ delivered: 0, retried: 0, dead: 0 }); // not due yet
    app.env.clock.advance(500);
    expect((await app.dispatcher.drain()).retried).toBe(1);
    app.env.clock.advance(1000);
    expect((await app.dispatcher.drain()).delivered).toBe(1);
    expect(app.psp.payments.size).toBe(1);

    const app2 = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    await app2.engine.handle({ principal: alice(app2.env), body, idempotencyKey: "idem-retry-2" });
    app2.psp.failNext = 99;
    for (let i = 0; i < 5; i++) {
      await app2.dispatcher.drain();
      app2.env.clock.advance(60_000);
    }
    expect(app2.db.prepare("SELECT status, attempts FROM mn_outbox").get()).toEqual({ status: "dead", attempts: 5 });
  });
});

describe("secret custody", () => {
  it("secret values never appear in the audit log, the trace, or the outbox", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-sec-1" });
    (app.secrets as MemorySecretStore).rotate("psp.apiKey", "sk_wrong_key_9999"); // provider will reject with 401
    await app.dispatcher.drain();
    const everything = JSON.stringify([(app.audit as any).records, [...(app.traces as any).traces.values()], app.db.prepare("SELECT * FROM mn_outbox").all()]);
    const signingKey = (app.secrets as MemorySecretStore).get("ingress.signingKey"); // random per process
    expect(signingKey.length).toBeGreaterThanOrEqual(32);
    for (const s of ["sk_test_psp_0001", "sk_wrong_key_9999", signingKey]) expect(everything).not.toContain(s);
  });
  it("rotation takes effect at the next send without recompiling the contract", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    const hash = app.contract.hash;
    await app.engine.handle({ principal: alice(app.env), body, idempotencyKey: "idem-rot-1" });
    (app.secrets as MemorySecretStore).rotate("psp.apiKey", "sk_rotated_0002");
    app.psp.acceptedKey = "sk_rotated_0002";
    expect((await app.dispatcher.drain()).delivered).toBe(1);
    expect(app.contract.hash).toBe(hash);
  });
});

describe("policy change without touching service code (PRD §11)", () => {
  it("30 -> 14 day window: recompile the contract, behaviour changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-"));
    const p14 = join(dir, "refund.create.yaml");
    writeFileSync(p14, readFileSync(CONTRACT_PATH, "utf8").replace('requires: ["order.ageDays <= 30"]', 'requires: ["order.ageDays <= 14"]'));
    const req = { orderId: "ord_a6", message: "changed my mind" }; // 20 days old
    const a30 = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    const a14 = makeApp(scripted(propose("CHANGED_MIND", fullRefund)), { contractPath: p14 });
    expect((await a30.engine.handle({ principal: alice(a30.env), body: req, idempotencyKey: "idem-pol-1" })).outcome).toBe("ALLOW");
    const r14 = await a14.engine.handle({ principal: alice(a14.env), body: req, idempotencyKey: "idem-pol-1" });
    expect(r14).toMatchObject({ outcome: "REFUSE", code: "INVARIANT_VIOLATION" });
    expect(a14.contract.hash).not.toBe(a30.contract.hash);
  });
});

describe("HTTP ingress", () => {
  it("identity comes only from a valid signed token", async () => {
    const app = makeApp(scripted(propose("CHANGED_MIND", fullRefund)));
    const server = createServer([app.engine], app.identity).listen(0);
    const port = (server.address() as { port: number }).port;
    const call = (headers: Record<string, string>, b: unknown = body) =>
      fetch(`http://127.0.0.1:${port}/v1/refund.create`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
    try {
      const good = app.identity.issue({ subject: "u_alice", tenant: "t_acme", sessionId: "s1", scopes: ["refund:request"] });
      const forged = good.slice(0, good.lastIndexOf(".")) + ".AAAA";
      const bobAsAlice = app.identity.issue({ subject: "u_bob", tenant: "t_acme", sessionId: "s2", scopes: ["refund:request"] });
      expect((await call({ "idempotency-key": "idem-http-1" })).status).toBe(401);
      expect((await call({ authorization: `Bearer ${forged}`, "idempotency-key": "idem-http-1" })).status).toBe(401);
      expect((await call({ authorization: `Bearer ${bobAsAlice}`, "idempotency-key": "idem-http-1" })).status).toBe(403);
      const ok = await call({ authorization: `Bearer ${good}`, "idempotency-key": "idem-http-1" });
      expect(ok.status).toBe(201);
      expect(bal(app.db, "ord_a1").c).toBe(0);
    } finally {
      server.close();
    }
  });
});
