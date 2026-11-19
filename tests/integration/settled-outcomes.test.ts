/**
 * Audit findings R4 (answer divergence after lease expiry) and the settled-outcome prototype.
 * Opt-in: idempotency.settle = "terminal". The default ("release") is unchanged and is tested
 * alongside, so the client-visible difference is explicit.
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { Executor, scopedKey } from "@modelnativ/effect-executor";
import { sha256 } from "@modelnativ/observability";
import { canonicalJson } from "@modelnativ/contract-schema";
import { FaultPlan, NO_FAULTS, VirtualClock, createApp, drive, testEnv, type IdempotencyOptions, type OperationResult, type ReadTool } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const body = { rewardId: "rw_1", quantity: 1 };
const TERMINAL: IdempotencyOptions = { settle: "terminal" };

function file(stock: number) {
  const f = join(mkdtempSync(join(tmpdir(), "mn-settle-")), "app.db");
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 5000, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock, minTier: "bronze" }]);
  db.close();
  return f;
}
function instance(f: string, seed: number, clock: VirtualClock, idem: IdempotencyOptions, o: { delay?: number; faults?: FaultPlan } = {}) {
  const db = new Database(f);
  db.pragma("busy_timeout = 5000");
  const cfg = o.delay ? { ...loyaltyC, tools: (c: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(c).map((t): ReadTool => ({ ...t, read: async (a, x) => (await clock.sleep(o.delay!), t.read(a, x)) })) } : loyaltyC;
  const app = createApp({ ...cfg, destinations: () => [] }, DIR, { env: testEnv(seed, { clock, faults: o.faults ?? NO_FAULTS }), db, engine: { serialize: false, idempotency: idem } });
  return { db, go: (key: string, b: Record<string, unknown> = body) => app.engines[0]!.handle({ principal: { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 3.6e6 }, body: b, idempotencyKey: key }) };
}
const restock = (db: Database.Database, n: number) => db.prepare("UPDATE rewards SET stock = ?").run(n);
const redemptions = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n;
const answer = (r: OperationResult) => [r.outcome, r.code ?? null, r.reason ?? null];

describe("settled outcomes (opt-in) vs the default", () => {
  it("terminal: a retry with the same key and payload returns the settled refusal, even after state changed", async () => {
    const clock = new VirtualClock(NOW);
    const i = instance(file(0), 1, clock, TERMINAL);
    const first = await i.go("settle-key-0001");
    expect(answer(first)).toEqual(["REFUSE", "INVARIANT_VIOLATION", "out_of_stock"]);
    restock(i.db, 5);
    const retry = await i.go("settle-key-0001");
    expect(answer(retry)).toEqual(answer(first));
    expect(retry.answeredBy).toBe(first.operationId);
    expect(redemptions(i.db)).toBe(0);
    // a NEW business attempt uses a new key and is evaluated on current state
    expect((await i.go("settle-key-0002")).outcome).toBe("ALLOW");
  });

  it("default (release): the same retry re-evaluates and can succeed: the client-visible difference", async () => {
    const clock = new VirtualClock(NOW);
    const i = instance(file(0), 1, clock, {});
    expect((await i.go("rel-key-0001")).reason).toBe("out_of_stock");
    restock(i.db, 5);
    expect((await i.go("rel-key-0001")).outcome).toBe("ALLOW");
  });

  it("terminal: a different payload with a settled key is REPLAY_DETECTED", async () => {
    const i = instance(file(0), 1, new VirtualClock(NOW), TERMINAL);
    await i.go("settle-key-0003");
    expect((await i.go("settle-key-0003", { rewardId: "rw_1", quantity: 2 })).code).toBe("REPLAY_DETECTED");
  });

  it("terminal: transient infrastructure failures are NOT settled; the same key retries and commits", async () => {
    const clock = new VirtualClock(NOW);
    const i = instance(file(5), 1, clock, TERMINAL, { faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    expect((await i.go("settle-key-0004")).code).toBe("EXECUTION_FAILED");
    const retry = await i.go("settle-key-0004");
    expect(retry).toMatchObject({ outcome: "ALLOW", effect: { status: "committed" } });
    expect(redemptions(i.db)).toBe(1);
  });

  it("terminal: committed successes stay settled (a retry returns the same effect)", async () => {
    const i = instance(file(5), 1, new VirtualClock(NOW), TERMINAL);
    const a = await i.go("settle-key-0005");
    expect((await i.go("settle-key-0005")).effect).toMatchObject({ status: "duplicate", effectId: a.effect!.effectId });
  });
});

describe("stale owner after lease expiry (audit P1)", () => {
  // A owns the key and stalls past its lease; B takes over, sees stock 0 and refuses; stock is then
  // replenished; A wakes with a decision of ALLOW.
  async function scenario(idem: IdempotencyOptions) {
    const clock = new VirtualClock(NOW);
    const f = file(0);
    const a = instance(f, 1, clock, { ...idem, leaseMs: 100 }, { delay: 500 });
    const b = instance(f, 2, clock, { ...idem, leaseMs: 100 });
    const [ra, rb] = (await drive(
      Promise.all([a.go("stale-key-0001"), (async () => (await clock.sleep(200), b.go("stale-key-0001")))(), (async () => (await clock.sleep(300), restock(a.db, 5)))()]),
      clock,
      1_000_000,
    )) as OperationResult[];
    const later = await drive(b.go("stale-key-0001"), clock);
    return { ra: ra!, rb: rb!, later, n: redemptions(a.db) };
  }

  it("default (release): divergence remains possible (documented): B refused, A committed", async () => {
    const r = await scenario({});
    expect(answer(r.rb)).toEqual(["REFUSE", "INVARIANT_VIOLATION", "out_of_stock"]);
    expect(r.ra.outcome).toBe("ALLOW");
    expect(r.n).toBe(1);
  });

  it("terminal: the stale owner is fenced at commit and converges: every answer is B's refusal, nothing committed", async () => {
    const r = await scenario(TERMINAL);
    expect(answer(r.rb)).toEqual(["REFUSE", "INVARIANT_VIOLATION", "out_of_stock"]);
    expect(answer(r.ra)).toEqual(answer(r.rb));
    expect(r.ra.answeredBy).toBe(r.rb.operationId);
    expect(answer(r.later)).toEqual(answer(r.rb));
    expect(r.n).toBe(0);
  });

  it("terminal: a claim left by a crashed owner (never settled) is still taken over after its lease", async () => {
    const clock = new VirtualClock(NOW);
    const f = file(5);
    const b = instance(f, 2, clock, { ...TERMINAL, waitMs: 1_000 });
    new Executor(new Database(f), clock, NO_FAULTS, () => "x", []).claimKey(scopedKey("t_a", "m_1", "loyalty.redeem", "crash-key-0001"), sha256(canonicalJson(body)), "op_dead", 30_000);
    expect((await drive(b.go("crash-key-0001"), clock)).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    clock.advance(30_000);
    expect((await drive(b.go("crash-key-0001"), clock)).outcome).toBe("ALLOW");
  });
});
