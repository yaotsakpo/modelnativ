/**
 * Audit findings: embedded results mapped infrastructure failures to business answers (422
 * "not_found"), and fallback mode could run legacy twice (R5) or after a committed effect.
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { ModelnativRetryableError, ModelnativUnexpectedError, classify, createModelnativ, type Mode } from "@modelnativ/core";
import { FaultPlan, NO_FAULTS, VirtualClock, createApp, createServer, drive, testEnv, type OperationResult, type ReadTool } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const principal = { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 3.6e6 };

function file(stock = 5) {
  const f = join(mkdtempSync(join(tmpdir(), "mn-sdk-")), "app.db");
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 5000, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock, minTier: "bronze" }]);
  db.close();
  return f;
}
function instance(f: string, seed: number, clock: VirtualClock, o: { faults?: FaultPlan; delay?: number } = {}) {
  const db = new Database(f);
  db.pragma("busy_timeout = 5000");
  const cfg = o.delay ? { ...loyaltyC, tools: (c: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(c).map((t): ReadTool => ({ ...t, read: async (a, x) => (await clock.sleep(o.delay!), t.read(a, x)) })) } : loyaltyC;
  const app = createApp({ ...cfg, destinations: () => [] }, DIR, { env: testEnv(seed, { clock, faults: o.faults ?? NO_FAULTS }), db, engine: { serialize: false } });
  return { db, app };
}
/** A host binding like the loyalty Express app's: output maps business answers only. */
function bound(app: ReturnType<typeof instance>["app"], mode: Mode, legacy: () => Promise<string>, key = "sdk-key-0001", quantity = 1) {
  return createModelnativ(app.engines, { modes: { "loyalty.redeem": mode } }).bind("loyalty.redeem", legacy, {
    principal: () => principal,
    input: () => ({ rewardId: "rw_1", quantity }),
    idempotencyKey: () => key,
    output: (r) => (r.outcome === "ALLOW" ? `redeemed:${r.effect!.status}` : `rejected:${r.reason}`),
    normalizeLegacy: () => ({ outcome: "ALLOW" }),
    normalizeModelnativ: () => ({ outcome: "ALLOW" }),
  });
}
const redemptions = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n;
const r = (o: Partial<OperationResult>) => ({ traceId: "", operationId: "", httpStatus: 0, ...o }) as OperationResult;

describe("embedded SDK: business answers vs infrastructure failures", () => {
  it("classify separates every outcome kind", () => {
    expect(classify(r({ outcome: "ALLOW" }))).toBe("committed");
    expect(classify(r({ outcome: "REFUSE", code: "INVARIANT_VIOLATION", reason: "out_of_stock" }))).toBe("business_refusal");
    expect(classify(r({ outcome: "REFUSE", code: "TENANT_VIOLATION" }))).toBe("business_refusal");
    expect(classify(r({ outcome: "REVIEW", code: "UNESTABLISHED_REQUIREMENT" }))).toBe("review");
    expect(classify(r({ outcome: "CLARIFY" }))).toBe("clarify");
    for (const code of ["EXECUTION_FAILED", "DEADLINE_EXCEEDED", "RATE_LIMITED", "OVERLOADED", "IDEMPOTENCY_IN_PROGRESS", "STALE_STATE", "MODEL_UNAVAILABLE"] as const)
      expect(classify(r({ outcome: "REFUSE", code }))).toBe("retryable");
    // a declared application reason makes it the application's answer (e.g. a version conflict)
    expect(classify(r({ outcome: "REFUSE", code: "STALE_STATE", reason: "version_conflict" }))).toBe("business_refusal");
  });

  it("business refusals reach the host's output mapping (unchanged)", async () => {
    const { app } = instance(file(0), 1, new VirtualClock(NOW));
    expect(await bound(app, "modelnativ", async () => "legacy")()).toBe("rejected:out_of_stock");
  });

  it("an infrastructure failure throws ModelnativRetryableError instead of becoming a business answer (was: rejected:not_found / 422)", async () => {
    const { app, db } = instance(file(), 1, new VirtualClock(NOW), { faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    const err = await bound(app, "modelnativ", async () => "legacy")().catch((e) => e);
    expect(err).toBeInstanceOf(ModelnativRetryableError);
    expect(err.code).toBe("EXECUTION_FAILED");
    expect(redemptions(db)).toBe(0);
    expect(await bound(app, "modelnativ", async () => "legacy")()).toBe("redeemed:committed"); // retry, same key
  });

  it("onInfrastructure: 'output' keeps the previous behaviour for hosts that want it", async () => {
    const { app } = instance(file(), 1, new VirtualClock(NOW), { faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    const legacy = async () => "legacy";
    const b = createModelnativ(app.engines, { modes: { "loyalty.redeem": "modelnativ" } }).bind("loyalty.redeem", legacy, {
      principal: () => principal, input: () => ({ rewardId: "rw_1", quantity: 1 }), idempotencyKey: () => "sdk-key-0002",
      output: (x) => `${classify(x)}:${x.code}`, normalizeLegacy: () => ({ outcome: "ALLOW" }), normalizeModelnativ: () => ({ outcome: "ALLOW" }), onInfrastructure: "output",
    });
    expect(await b()).toBe("retryable:EXECUTION_FAILED");
  });
});

describe("fallback mode never repeats work", () => {
  it("a converged duplicate does not run legacy again (audit P5: was 2 legacy calls)", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const a = instance(f, 1, clock, { delay: 100, faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    const b = instance(f, 2, clock);
    let legacyCalls = 0;
    const legacy = async () => (legacyCalls++, "legacy");
    const [x, y] = await drive(Promise.all([bound(a.app, "fallback", legacy, "fb-key-0001")().catch((e) => e), (async () => (await clock.sleep(10), bound(b.app, "fallback", legacy, "fb-key-0001")().catch((e) => e)))()]), clock);
    expect(legacyCalls).toBe(1);
    expect(x).toBe("legacy"); // the owner fell back
    expect(y).toBeInstanceOf(ModelnativRetryableError); // the converged duplicate did not
    expect((y as ModelnativRetryableError).result.answeredBy).toBeDefined();
  });

  it("an unexpected failure after commit never falls back to legacy (the effect is committed)", async () => {
    const { app, db } = instance(file(), 1, new VirtualClock(NOW), { faults: new FaultPlan().arm("engine.afterCommit", "crash") });
    let legacyCalls = 0;
    const err = await bound(app, "fallback", async () => (legacyCalls++, "legacy"), "fb-key-0002")().catch((e) => e);
    expect(err).toBeInstanceOf(ModelnativUnexpectedError);
    expect(legacyCalls).toBe(0);
    expect(redemptions(db)).toBe(1);
  });

  it("a fallback-eligible failure with a committed effect for the key returns that effect, not legacy", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const { app, db } = instance(f, 1, clock);
    expect(await bound(app, "modelnativ", async () => "legacy", "fb-key-0003")()).toBe("redeemed:committed");
    // force the kernel to report a fallback-eligible failure for the same key (as a buggy or racing path could)
    const engine = app.engines[0]!;
    const real = engine.handle.bind(engine);
    (engine as { handle: typeof engine.handle }).handle = async (q, o) => ({ ...(await real(q, o)), outcome: "REFUSE", code: "EXECUTION_FAILED", effect: undefined, httpStatus: 503 });
    let legacyCalls = 0;
    expect(await bound(app, "fallback", async () => (legacyCalls++, "legacy"), "fb-key-0003")()).toBe("redeemed:duplicate");
    expect(legacyCalls).toBe(0);
    expect(redemptions(db)).toBe(1);
  });
});

describe("standalone HTTP: 5xx bodies carry no internal detail", () => {
  it("EXECUTION_FAILED answers 503 without the database error text", async () => {
    const { app } = instance(file(), 1, new VirtualClock(NOW), { faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    const server = createServer(app.engines, app.identity, { onError: () => {} }).listen(0);
    try {
      const token = app.identity.issue({ subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"] } as never, 3_600_000);
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/loyalty.redeem`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": "http-5xx-0001", "content-type": "application/json" }, body: JSON.stringify({ rewardId: "rw_1", quantity: 1 }) });
      const json = await res.json();
      expect(res.status).toBe(503);
      expect(json).toMatchObject({ outcome: "REFUSE", code: "EXECUTION_FAILED" });
      expect(json.detail).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
