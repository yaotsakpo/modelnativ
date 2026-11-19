/**
 * Durable idempotency across independent runtime instances sharing one database.
 *
 * Each instance is a separate `createApp` with its own SQLite connection to the same file,
 * its own engine and its own process-local queue (turned off anyway). Correctness comes only
 * from the claim in the shared database. Covers: pending (a duplicate waits and converges),
 * committed, conflicting payload, failed, timed-out, crash recovery (lease takeover) and fencing.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { ControlledScheduler, FaultPlan, VirtualClock, createApp, drive, exploreSchedules, testEnv, type Engine, type OperationResult, type ReadTool } from "@modelnativ/runtime";
import { Executor, scopedKey } from "@modelnativ/effect-executor";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const KEY = "same-key-0001";
const body = { rewardId: "rw_1", quantity: 1 };

function sharedDb(stock = 1): string {
  const file = join(mkdtempSync(join(tmpdir(), "mn-idem-")), "app.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 500, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock, minTier: "bronze" }]);
  db.close();
  return file;
}

type Inst = { engine: Engine; db: Database.Database; faults: FaultPlan };
/** One runtime instance: its own connection, engine, id stream and fault plan; time and scheduling may be shared. */
function instance(file: string, seed: number, shared: { clock: VirtualClock; scheduler?: ControlledScheduler }, opts: { delayFactsMs?: number; idem?: { leaseMs?: number; waitMs?: number; pollMs?: number } } = {}): Inst {
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  const faults = new FaultPlan();
  const env = testEnv(seed, { clock: shared.clock, faults, ...(shared.scheduler ? { scheduler: shared.scheduler } : {}) });
  const config = opts.delayFactsMs
    ? { ...loyaltyC, tools: (ctx: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(ctx).map((t): ReadTool => ({ ...t, read: async (a, c) => (await shared.clock.sleep(opts.delayFactsMs!), t.read(a, c)) })) }
    : loyaltyC;
  const app = createApp({ ...config, destinations: () => [] }, DIR, { env, db });
  const engine = app.engines[0]!;
  const d = (engine as unknown as { d: { serialize: boolean; idempotency?: unknown } }).d;
  d.serialize = false; // the process-local queue plays no part in correctness
  d.idempotency = { leaseMs: 30_000, waitMs: 5_000, pollMs: 50, ...(opts.idem ?? {}) };
  return { engine, db, faults };
}
const go = (i: Inst, b: Record<string, unknown> = body, key = KEY) =>
  i.engine.handle({ principal: { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 3_600_000 }, body: b, idempotencyKey: key });
const redemptions = (db: Database.Database) => (db.prepare("SELECT COUNT(*) n FROM redemptions").get() as { n: number }).n;
const stock = (db: Database.Database) => (db.prepare("SELECT stock FROM rewards").get() as { stock: number }).stock;
const answer = (r: OperationResult) => [r.outcome, r.code ?? null, r.reason ?? null, r.effect?.effectId ?? null];
const clockAt = () => new VirtualClock(NOW);

describe("durable idempotency across two runtime instances (shared database)", () => {
  it("pending -> committed: simultaneous duplicates on two instances converge on one committed result (every schedule)", { timeout: 120_000 }, async () => {
    const r = await exploreSchedules(async () => {
      const scheduler = new ControlledScheduler();
      const clock = clockAt();
      scheduler.clock = clock;
      const file = sharedDb(1);
      const a = instance(file, 1, { clock, scheduler });
      const b = instance(file, 2, { clock, scheduler });
      return {
        scheduler,
        tasks: { A: () => go(a), B: () => go(b) },
        check: (res) => {
          expect(res.deadlock).toBe(false);
          const [x, y] = Object.values(res.results) as OperationResult[];
          expect(x!.outcome).toBe("ALLOW");
          expect(answer(y!)).toEqual(answer(x!)); // same answer, same effect id
          expect(redemptions(a.db)).toBe(1);
          expect(stock(a.db)).toBe(0);
        },
      };
    });
    expect(r.exhaustive).toBe(true);
    expect(r.explored).toBeGreaterThan(1);
  });

  it("conflict: the same key with a different payload is REPLAY_DETECTED while pending, after commit, and after a refusal", async () => {
    const clock = clockAt();
    const file = sharedDb(5);
    const a = instance(file, 1, { clock });
    const b = instance(file, 2, { clock });
    // pending: another instance holds the claim (taken directly on its executor)
    const ex = new Executor(b.db, clock, new FaultPlan(), () => "x", []);
    const k = scopedKey("t_a", "m_1", "loyalty.redeem", "pend-key-0001");
    const { sha256 } = await import("@modelnativ/observability");
    const { canonicalJson } = await import("@modelnativ/contract-schema");
    expect(ex.claimKey(k, sha256(canonicalJson(body)), "op_other", 30_000).kind).toBe("claimed");
    expect((await go(a, { rewardId: "rw_1", quantity: 2 }, "pend-key-0001")).code).toBe("REPLAY_DETECTED");
    // committed
    expect((await go(a, body, "done-key-0001")).outcome).toBe("ALLOW");
    expect((await go(b, { rewardId: "rw_1", quantity: 2 }, "done-key-0001")).code).toBe("REPLAY_DETECTED");
    // released after a refusal (quantity over stock): the key stays bound to its first payload
    expect((await go(a, { rewardId: "rw_1", quantity: 99 }, "refd-key-0001")).reason).toBe("out_of_stock");
    expect((await go(b, body, "refd-key-0001")).code).toBe("REPLAY_DETECTED");
    expect(redemptions(a.db)).toBe(1);
  });

  it("failed: a waiting duplicate gets the owner's failure; a later retry re-evaluates and commits once", async () => {
    const clock = clockAt();
    const file = sharedDb(1);
    const a = instance(file, 1, { clock }, { delayFactsMs: 100 });
    const b = instance(file, 2, { clock });
    a.faults.arm("engine.beforeCommit", "db", 1);
    const pa = go(a);
    const pb = (async () => (await clock.sleep(10), go(b)))(); // arrives while A holds the key
    const [ra, rb] = await drive(Promise.all([pa, pb]), clock);
    expect(ra.code).toBe("EXECUTION_FAILED");
    expect(answer(rb)).toEqual(answer(ra));
    expect(redemptions(a.db)).toBe(0);
    const retry = await drive(go(b), clock);
    expect(retry.outcome).toBe("ALLOW");
    expect(retry.effect!.status).toBe("committed");
    expect(redemptions(a.db)).toBe(1);
  });

  it("timed out: a duplicate that waits longer than waitMs gets IDEMPOTENCY_IN_PROGRESS (409, Retry-After) and changes nothing", async () => {
    const clock = clockAt();
    const file = sharedDb(1);
    const a = instance(file, 1, { clock }, { delayFactsMs: 10_000 }); // a very slow owner
    const b = instance(file, 2, { clock }, { idem: { waitMs: 1_000 } });
    const pa = go(a);
    const rb = await drive((async () => (await clock.sleep(10), go(b)))(), clock);
    expect(rb).toMatchObject({ outcome: "REFUSE", code: "IDEMPOTENCY_IN_PROGRESS", httpStatus: 409 });
    expect(rb.retryAfterMs).toBeGreaterThan(0);
    expect(redemptions(a.db)).toBe(0);
    const ra = await drive(pa, clock);
    expect(ra.outcome).toBe("ALLOW");
    expect(answer(await drive(go(b), clock))).toEqual(answer(ra)); // after it settles, the retry returns it
  });

  it("crash recovery: a claim left by a crashed owner is taken over after its lease; never before", async () => {
    const clock = clockAt();
    const file = sharedDb(1);
    const b = instance(file, 2, { clock }, { idem: { waitMs: 1_000, leaseMs: 30_000 } });
    const { sha256 } = await import("@modelnativ/observability");
    const { canonicalJson } = await import("@modelnativ/contract-schema");
    const dead = new Executor(new Database(file), clock, new FaultPlan(), () => "x", []);
    dead.claimKey(scopedKey("t_a", "m_1", "loyalty.redeem", KEY), sha256(canonicalJson(body)), "op_crashed", 30_000); // then the process dies
    const early = await drive(go(b), clock);
    expect(early.code).toBe("IDEMPOTENCY_IN_PROGRESS"); // lease still live: no second evaluation
    clock.advance(30_000);
    const after = await drive(go(b), clock);
    expect(after.outcome).toBe("ALLOW");
    expect(after.effect!.status).toBe("committed");
    expect(redemptions(b.db)).toBe(1);
  });

  it("crash recovery while waiting: a duplicate waiting on a dead owner takes over when the lease expires", async () => {
    const clock = clockAt();
    const file = sharedDb(1);
    const b = instance(file, 2, { clock }, { idem: { waitMs: 10_000, leaseMs: 2_000 } });
    const { sha256 } = await import("@modelnativ/observability");
    const { canonicalJson } = await import("@modelnativ/contract-schema");
    new Executor(new Database(file), clock, new FaultPlan(), () => "x", []).claimKey(scopedKey("t_a", "m_1", "loyalty.redeem", KEY), sha256(canonicalJson(body)), "op_crashed", 2_000);
    const r = await drive(go(b), clock);
    expect(r.outcome).toBe("ALLOW");
    expect(redemptions(b.db)).toBe(1);
  });

  it("stale owner at decision: an owner whose lease was taken over discards its refusal and converges on the new owner's result", async () => {
    const clock = clockAt();
    const file = sharedDb(1);
    const a = instance(file, 1, { clock }, { delayFactsMs: 500, idem: { leaseMs: 100 } }); // stalls past its lease
    const b = instance(file, 2, { clock }, { idem: { leaseMs: 100 } });
    const pa = go(a);
    const pb = (async () => (await clock.sleep(200), go(b)))(); // A's lease has expired: B takes over
    const [ra, rb] = await drive(Promise.all([pa, pb]), clock);
    expect(rb.outcome).toBe("ALLOW");
    expect(answer(ra)).toEqual(answer(rb));
    expect(redemptions(a.db)).toBe(1);
    expect(stock(a.db)).toBe(0);
  });

  it("stale owner at commit: one whose gate still allows never writes a second effect, and returns the same effect", async () => {
    const clock = clockAt();
    const file = sharedDb(5); // enough stock that the stale owner's gate says ALLOW
    const a = instance(file, 1, { clock }, { delayFactsMs: 500, idem: { leaseMs: 100 } });
    const b = instance(file, 2, { clock }, { idem: { leaseMs: 100 } });
    const pa = go(a);
    const pb = (async () => (await clock.sleep(200), go(b)))();
    const [ra, rb] = await drive(Promise.all([pa, pb]), clock);
    expect(rb.outcome).toBe("ALLOW");
    expect(answer(ra)).toEqual(answer(rb));
    expect(redemptions(a.db)).toBe(1);
    expect(stock(a.db)).toBe(4);
  });
});

describe("durable idempotency across two OS processes (real clock, shared SQLite file)", () => {
  it("two processes sending the same key at the same moment commit once and return the same effect", { timeout: 120_000 }, async () => {
    const file = sharedDb(3);
    const child = join(import.meta.dirname, "fixtures", "idem-child.ts");
    for (let round = 0; round < 3; round++) {
      const key = `proc-key-${round}000`;
      const startAt = Date.now() + 4_000; // both processes are up before this instant
      const run = () =>
        new Promise<OperationResult>((resolve, reject) => {
          const p = spawn(process.execPath, ["--import", "tsx", child, file, key, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err += d));
          p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1)!)) : reject(new Error(err || `exit ${code}`))));
        });
      const [x, y] = await Promise.all([run(), run()]);
      expect(x.outcome).toBe("ALLOW");
      expect(answer(y)).toEqual(answer(x));
      expect([x.effect!.status, y.effect!.status].sort()).toEqual(["committed", "duplicate"]);
    }
    const db = new Database(file);
    expect(redemptions(db)).toBe(3);
    expect(stock(db)).toBe(0);
  });
});
