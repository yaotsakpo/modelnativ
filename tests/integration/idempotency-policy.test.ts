/**
 * Idempotency policy decision: contracts declare `spec.idempotency.settle`; recommended for new
 * operations is "terminal"; contracts without the field keep their behaviour; settled answers are
 * remembered for retentionMs only; transient failures stay retryable; stale workers stay fenced.
 */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { idempotencyRecommendations } from "@modelnativ/analyzer-typescript";
import { compileContract } from "@modelnativ/contract-compiler";
import { Executor } from "@modelnativ/effect-executor";
import { FaultPlan, NO_FAULTS, VirtualClock, createApp, drive, testEnv, type IdempotencyOptions, type OperationResult, type ReadTool } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const body = { rewardId: "rw_1", quantity: 1 };

/** The concise loyalty contract with an idempotency policy declared (as a new operation would). */
function contractWith(policy: Record<string, unknown> | null) {
  const doc = YAML.parse(readFileSync(join(DIR, "loyalty.redeem.yaml"), "utf8"));
  if (policy) doc.spec.idempotency = policy;
  const dir = mkdtempSync(join(tmpdir(), "mn-pol-"));
  writeFileSync(join(dir, "loyalty.redeem.yaml"), YAML.stringify(doc));
  return join(dir, "loyalty.redeem.yaml");
}
function file(stock: number) {
  const f = join(mkdtempSync(join(tmpdir(), "mn-pol-db-")), "app.db");
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 5000, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock, minTier: "bronze" }]);
  db.close();
  return f;
}
function instance(f: string, contract: string, clock: VirtualClock, o: { seed?: number; engineIdem?: IdempotencyOptions; delay?: number; faults?: FaultPlan } = {}) {
  const db = new Database(f);
  db.pragma("busy_timeout = 5000");
  const tools = o.delay ? (c: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(c).map((t): ReadTool => ({ ...t, read: async (a, x) => (await clock.sleep(o.delay!), t.read(a, x)) })) : loyaltyC.tools;
  const app = createApp({ ...loyaltyC, tools, contracts: [contract], destinations: () => [] }, DIR, { env: testEnv(o.seed ?? 1, { clock, faults: o.faults ?? NO_FAULTS }), db, engine: { serialize: false, ...(o.engineIdem ? { idempotency: o.engineIdem } : {}) } });
  return { db, app, go: (key: string, b: Record<string, unknown> = body) => app.engines[0]!.handle({ principal: { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 400 * 86_400_000 }, body: b, idempotencyKey: key }) };
}
const restock = (db: Database.Database, n: number) => db.prepare("UPDATE rewards SET stock = ?").run(n);
const answer = (r: OperationResult) => [r.outcome, r.code ?? null, r.reason ?? null];

describe("idempotency policy declared by the contract", () => {
  it("a contract declaring settle: terminal settles business refusals (no engine configuration needed)", async () => {
    const i = instance(file(0), contractWith({ settle: "terminal" }), new VirtualClock(NOW));
    const first = await i.go("pol-key-0001");
    restock(i.db, 5);
    const again = await i.go("pol-key-0001");
    expect(answer(again)).toEqual(answer(first));
    expect(again.answeredBy).toBe(first.operationId);
  });

  it("a contract WITHOUT the field keeps its existing behaviour (release): no silent change", async () => {
    const i = instance(file(0), contractWith(null), new VirtualClock(NOW));
    expect((await i.go("pol-key-0002")).reason).toBe("out_of_stock");
    restock(i.db, 5);
    expect((await i.go("pol-key-0002")).outcome).toBe("ALLOW");
  });

  it("the contract's declaration wins over the runtime default, in both directions", async () => {
    const a = instance(file(0), contractWith({ settle: "release" }), new VirtualClock(NOW), { engineIdem: { settle: "terminal" } });
    await a.go("pol-key-0003");
    restock(a.db, 5);
    expect((await a.go("pol-key-0003")).outcome).toBe("ALLOW");
    const b = instance(file(0), contractWith(null), new VirtualClock(NOW), { engineIdem: { settle: "terminal" } });
    await b.go("pol-key-0004");
    restock(b.db, 5);
    expect((await b.go("pol-key-0004")).reason).toBe("out_of_stock"); // runtime default applies when undeclared
  });

  it("settled answers last for retentionMs only: afterwards the same key is a new attempt (any payload)", async () => {
    const clock = new VirtualClock(NOW);
    const i = instance(file(0), contractWith({ settle: "terminal", retentionMs: 60_000 }), clock);
    expect((await i.go("pol-key-0005")).reason).toBe("out_of_stock");
    restock(i.db, 5);
    clock.advance(59_000);
    expect((await i.go("pol-key-0005")).reason).toBe("out_of_stock"); // still within retention
    clock.advance(1_000);
    expect((await i.go("pol-key-0005", { rewardId: "rw_1", quantity: 2 })).outcome).toBe("ALLOW"); // expired: new attempt
  });

  it("transient infrastructure failures stay retryable under settle: terminal", async () => {
    const i = instance(file(5), contractWith({ settle: "terminal" }), new VirtualClock(NOW), { faults: new FaultPlan().arm("engine.beforeCommit", "db", 1) });
    expect((await i.go("pol-key-0006")).code).toBe("EXECUTION_FAILED");
    expect((await i.go("pol-key-0006")).effect?.status).toBe("committed");
  });

  it("stale-worker fencing holds with the contract-declared policy (lease expiry, takeover, refusal, late ALLOW)", async () => {
    const clock = new VirtualClock(NOW);
    const f = file(0);
    const c = contractWith({ settle: "terminal" });
    const a = instance(f, c, clock, { seed: 1, delay: 500, engineIdem: { leaseMs: 100 } });
    const b = instance(f, c, clock, { seed: 2, engineIdem: { leaseMs: 100 } });
    const [ra, rb] = (await drive(Promise.all([a.go("pol-stale-0001"), (async () => (await clock.sleep(200), b.go("pol-stale-0001")))(), (async () => (await clock.sleep(300), restock(a.db, 5)))()]), clock, 1_000_000)) as OperationResult[];
    expect(answer(rb!)).toEqual(["REFUSE", "INVARIANT_VIOLATION", "out_of_stock"]);
    expect(answer(ra!)).toEqual(answer(rb!));
    expect((a.db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n).toBe(0);
  });

  it("pruneClaims deletes released claims older than the cutoff, never pending ones", () => {
    const db = new Database(":memory:");
    const clock = new VirtualClock(NOW);
    const ex = new Executor(db, clock, NO_FAULTS, () => "x", []);
    ex.claimKey("k1", "h", "o1", 30_000);
    ex.releaseKey("k1", "o1", { outcome: "REFUSE" }, true);
    ex.claimKey("k2", "h", "o2", 30_000); // pending
    clock.advance(10_000);
    expect(ex.pruneClaims(clock.now())).toBe(1);
    expect((db.prepare("SELECT scoped_key FROM mn_claims").all() as { scoped_key: string }[]).map((r) => r.scoped_key)).toEqual(["k2"]);
  });

  it("the policy is part of the contract (schema-validated, hashed); lint recommends declaring it", () => {
    const doc = YAML.parse(readFileSync(join(DIR, "loyalty.redeem.yaml"), "utf8"));
    const without = compileContract(doc).hash;
    doc.spec.idempotency = { settle: "terminal" };
    expect(compileContract(doc).hash).not.toBe(without);
    doc.spec.idempotency = { settle: "forever" };
    expect(() => compileContract(doc)).toThrow();
    expect(idempotencyRecommendations(LOYALTY_ROOT).map((r) => r.file).sort()).toEqual(["c/loyalty.redeem.yaml", "loyalty.redeem.yaml"]);
    const dir = mkdtempSync(join(tmpdir(), "mn-pol-lint-"));
    writeFileSync(join(dir, "op.yaml"), readFileSync(contractWith({ settle: "terminal" }), "utf8"));
    expect(idempotencyRecommendations(dir)).toEqual([]);
  });
});
