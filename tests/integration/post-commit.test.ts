/**
 * Audit finding R1: once an effect is committed, failures persisting audit/trace/status must not
 * turn it into a reported failure. Covers sink failures, the HTTP server, and the crash window
 * between commit and audit (a limitation: the audit record of that operation is lost).
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { MemoryAudit } from "@modelnativ/observability";
import { FaultPlan, createApp, createServer, testEnv, type ObservabilityFailure } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const body = { rewardId: "rw_1", quantity: 1 };
const failing = { write() { throw new Error("audit disk full"); }, put() { throw new Error("trace store down"); }, get() { return undefined; } };

function setup(opts: { audit?: unknown; traces?: unknown; faults?: FaultPlan; db?: Database.Database; failures?: ObservabilityFailure[] } = {}) {
  const db = opts.db ?? new Database(":memory:");
  if (!opts.db) seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 500, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 5, minTier: "bronze" }]);
  const env = testEnv(1, opts.faults ? { faults: opts.faults } : {});
  const app = createApp({ ...loyaltyC, destinations: () => [] }, DIR, { env, db, ...(opts.audit ? { audit: opts.audit as never } : {}), ...(opts.traces ? { traces: opts.traces as never } : {}) });
  if (opts.failures) (app.engines[0] as unknown as { d: { onObservabilityFailure: (f: ObservabilityFailure) => void } }).d.onObservabilityFailure = (f) => opts.failures!.push(f);
  const principal = { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: env.clock.now() + 3.6e6 };
  return { db, env, app, go: (key = "post-key-0001") => app.engines[0]!.handle({ principal, body, idempotencyKey: key }) };
}
const redemptions = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n;

describe("post-commit: a committed effect is always reported as committed", () => {
  it("audit sink failure after commit: ALLOW committed, failure surfaced separately", async () => {
    const failures: ObservabilityFailure[] = [];
    const s = setup({ audit: failing, failures });
    const r = await s.go();
    expect(r).toMatchObject({ outcome: "ALLOW", httpStatus: 201, effect: { status: "committed" }, observability: { failed: ["audit"] } });
    expect(failures).toEqual([expect.objectContaining({ stage: "audit", committed: true, operation: "loyalty.redeem" })]);
    expect(redemptions(s.db)).toBe(1);
    const again = await s.go(); // a retry still returns the same effect
    expect(again.effect).toMatchObject({ status: "duplicate", effectId: r.effect!.effectId });
  });

  it("trace store failure: the outcome stands; audit still written", async () => {
    const audit = new MemoryAudit();
    const s = setup({ audit, traces: failing });
    const r = await s.go();
    expect(r).toMatchObject({ outcome: "ALLOW", observability: { failed: ["trace"] } });
    expect(audit.records).toHaveLength(1);
  });

  it("a refusal with a failing sink is still the refusal (nothing committed)", async () => {
    const s = setup({ audit: failing });
    const r = await s.app.engines[0]!.handle({ principal: { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: s.env.clock.now() + 3.6e6 }, body: { rewardId: "rw_1", quantity: 99 }, idempotencyKey: "refuse-key-0001" });
    expect(r).toMatchObject({ outcome: "REFUSE", reason: "out_of_stock", observability: { failed: ["audit"] } });
  });

  it("a throwing observability hook does not change the outcome", async () => {
    const s = setup({ audit: failing });
    (s.app.engines[0] as unknown as { d: { onObservabilityFailure: () => void } }).d.onObservabilityFailure = () => {
      throw new Error("hook bug");
    };
    expect((await s.go()).outcome).toBe("ALLOW");
  });

  it("crash between commit and audit: the effect survives, a retry on a fresh instance returns it; the audit record is lost (documented limitation)", async () => {
    const faults = new FaultPlan().arm("engine.afterCommit", "crash");
    const audit = new MemoryAudit();
    const s = setup({ faults, audit });
    await expect(s.go()).rejects.toThrow(/crash/); // the process "dies" here
    expect(redemptions(s.db)).toBe(1);
    expect(audit.records).toHaveLength(0);
    const ops = s.db.prepare("SELECT status FROM mn_operations").all() as { status: string }[];
    expect(ops.map((o) => o.status)).toEqual(["received"]); // status never updated
    const restarted = setup({ db: s.db });
    const r = await restarted.go();
    expect(r).toMatchObject({ outcome: "ALLOW", effect: { status: "duplicate" } });
    expect(redemptions(s.db)).toBe(1);
  });
});

describe("HTTP server: no hung request, no unhandled rejection", () => {
  let unhandled = 0;
  const onUnhandled = () => void unhandled++;
  beforeAll(() => void process.on("unhandledRejection", onUnhandled));
  afterAll(() => void process.off("unhandledRejection", onUnhandled));

  const post = async (server: ReturnType<ReturnType<typeof createServer>["listen"]>, path: string, token: string) => {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": "http-key-0001", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    return { status: r.status, body: await r.json() };
  };

  it("audit sink failure after commit answers 201 with the committed result", async () => {
    const s = setup({ audit: failing });
    const server = createServer(s.app.engines, s.app.identity, { onError: () => {} }).listen(0);
    try {
      const token = s.app.identity.issue({ subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"] } as never, 3_600_000);
      const r = await post(server, "/v1/loyalty.redeem", token);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ outcome: "ALLOW", effect: { status: "committed" }, observability: { failed: ["audit"] } });
    } finally {
      server.close();
    }
    expect(unhandled).toBe(0);
  });

  it("an unexpected exception answers 500 without internal detail, and is reported to onError", async () => {
    const errors: unknown[] = [];
    const boom = { contract: { name: "x.op" }, handle: async () => { throw new Error("secret internal state"); }, resume: async () => { throw new Error("x"); } };
    const s = setup();
    const server = createServer([boom as never], s.app.identity, { onError: (e) => errors.push(e) }).listen(0);
    try {
      const r = await post(server, "/v1/x.op", "t");
      expect(r).toEqual({ status: 500, body: { outcome: "ERROR", code: "INTERNAL_ERROR" } });
      expect(errors).toHaveLength(1);
    } finally {
      server.close();
    }
    expect(unhandled).toBe(0);
  });
});
