/**
 * Audit findings R2 (head-of-line blocking), R6 (polling load), R7 (deadline ignored while
 * waiting): duplicates wait OUTSIDE the per-resource queue, share one backed-off poller per key,
 * are capped per engine, and never wait past the request deadline.
 */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { VirtualClock, createApp, drive, testEnv, type IdempotencyOptions, type OperationResult, type ReadTool } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

const DIR = join(LOYALTY_ROOT, "c");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const body = { rewardId: "rw_1", quantity: 1 };

function file() {
  const f = join(mkdtempSync(join(tmpdir(), "mn-wait-")), "app.db");
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  seedLoyalty(db, [{ member: "m_1", tenant: "t_a", points: 5000, tier: "gold", status: "active" }, { member: "m_2", tenant: "t_a", points: 5000, tier: "gold", status: "active" }], [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 50, minTier: "bronze" }]);
  db.close();
  return f;
}
type Opts = { delay?: number; serialize?: boolean; idem?: IdempotencyOptions; contracts?: string[]; peeks?: { n: number } };
function instance(f: string, seed: number, clock: VirtualClock, o: Opts = {}) {
  const db = new Database(f);
  db.pragma("busy_timeout = 5000");
  const env = testEnv(seed, { clock });
  const base = { ...loyaltyC, destinations: () => [], ...(o.contracts ? { contracts: o.contracts } : {}) };
  const config = o.delay ? { ...base, tools: (c: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(c).map((t): ReadTool => ({ ...t, read: async (a, x) => (await clock.sleep(o.delay!), t.read(a, x)) })) } : base;
  const app = createApp(config, DIR, { env, db, engine: { serialize: o.serialize ?? true, idempotency: o.idem } });
  if (o.peeks) {
    const ex = app.executor as unknown as { peekKey: (...a: unknown[]) => unknown };
    const real = ex.peekKey.bind(ex);
    ex.peekKey = (...a: unknown[]) => (o.peeks!.n++, real(...a));
  }
  const engine = app.engines[0]!;
  return { engine, go: (key: string, m = "m_1") => engine.handle({ principal: { subject: m, tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 3.6e6 }, body, idempotencyKey: key }) };
}
const after = <T>(clock: VirtualClock, ms: number, f: () => Promise<T>) => (async () => (await clock.sleep(ms), f()))();

describe("duplicate waiting does not block, is bounded, and honours deadlines", () => {
  it("no head-of-line blocking: an unrelated request for the same resource is not queued behind a waiting duplicate", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const owner = instance(f, 1, clock, { delay: 1_000 }); // 4 reads: a 4 s owner on another instance
    const b = instance(f, 2, clock); // per-resource queue ON (the default)
    let unrelatedMs = -1;
    const [ro, rw, ru] = (await drive(
      Promise.all([
        owner.go("dup-key-0001"),
        after(clock, 10, () => b.go("dup-key-0001")), // waits for the owner
        after(clock, 20, async () => { const t = clock.now(); const r = await b.go("other-key-0001", "m_2"); unrelatedMs = clock.now() - t; return r; }),
      ]),
      clock,
      1_000_000,
    )) as OperationResult[];
    expect(ro!.outcome).toBe("ALLOW");
    expect(rw!.effect).toMatchObject({ status: "duplicate", effectId: ro!.effect!.effectId });
    expect(ru!.outcome).toBe("ALLOW");
    expect(unrelatedMs).toBe(0); // before the fix: ~3,990 ms (audit probe P2c)
  });

  it("the request deadline bounds the wait: DEADLINE_EXCEEDED (504) at the deadline, not after waitMs", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const doc = YAML.parse(readFileSync(join(DIR, "loyalty.redeem.yaml"), "utf8"));
    doc.spec.reliability = { deadlineMs: 300 };
    const dir = mkdtempSync(join(tmpdir(), "mn-dl-"));
    writeFileSync(join(dir, "loyalty.redeem.yaml"), YAML.stringify(doc));
    const owner = instance(f, 1, clock, { delay: 2_000 });
    const b = instance(f, 2, clock, { contracts: [join(dir, "loyalty.redeem.yaml")], idem: { waitMs: 5_000 } });
    let waitedMs = -1;
    const [, rb] = (await drive(Promise.all([owner.go("dl-key-0001"), after(clock, 10, async () => { const t = clock.now(); const r = await b.go("dl-key-0001"); waitedMs = clock.now() - t; return r; })]), clock, 1_000_000)) as OperationResult[];
    expect(rb).toMatchObject({ outcome: "REFUSE", code: "DEADLINE_EXCEEDED", httpStatus: 504 });
    expect(waitedMs).toBe(300); // before the fix: waitMs (5,000 ms)
  });

  it("waiters are capped per engine: beyond maxWaiters a duplicate gets IDEMPOTENCY_IN_PROGRESS immediately (409, Retry-After)", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const owner = instance(f, 1, clock, { delay: 500 });
    const b = instance(f, 2, clock, { serialize: false, idem: { maxWaiters: 3 } });
    const rs = (await drive(Promise.all([owner.go("cap-key-0001"), ...Array.from({ length: 10 }, () => after(clock, 10, () => b.go("cap-key-0001")))]), clock, 1_000_000)) as OperationResult[];
    const waiters = rs.slice(1);
    expect(waiters.filter((r) => r.effect?.status === "duplicate")).toHaveLength(3);
    const busy = waiters.filter((r) => r.code === "IDEMPOTENCY_IN_PROGRESS");
    expect(busy).toHaveLength(7);
    expect(busy.every((r) => r.httpStatus === 409 && r.retryAfterMs! > 0)).toBe(true);
    expect(b.engine.idempotencyWaiters).toBe(0); // all released
  });

  it("polling is coalesced and backed off: 200 waiters on a 2 s owner make few key reads", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const peeks = { n: 0 };
    const owner = instance(f, 1, clock, { delay: 500 });
    const b = instance(f, 2, clock, { serialize: false, peeks });
    const rs = (await drive(Promise.all([owner.go("poll-key-0001"), ...Array.from({ length: 200 }, () => after(clock, 10, () => b.go("poll-key-0001")))]), clock, 1_000_000)) as OperationResult[];
    expect(rs.slice(1).every((r) => r.effect?.status === "duplicate")).toBe(true);
    expect(peeks.n).toBeLessThan(20); // before the fix: 16,000 (audit probe P2)
  });

  it("a slow owner past waitMs: every waiter gets IDEMPOTENCY_IN_PROGRESS, with bounded reads", async () => {
    const clock = new VirtualClock(NOW);
    const f = file();
    const peeks = { n: 0 };
    const owner = instance(f, 1, clock, { delay: 2_000 }); // 8 s
    const b = instance(f, 2, clock, { serialize: false, peeks });
    const rs = (await drive(Promise.all([owner.go("slow-key-0001"), ...Array.from({ length: 50 }, () => after(clock, 10, () => b.go("slow-key-0001")))]), clock, 1_000_000)) as OperationResult[];
    expect(rs.slice(1).every((r) => r.code === "IDEMPOTENCY_IN_PROGRESS")).toBe(true);
    expect(peeks.n).toBeLessThan(40); // before the fix: 10,000 (audit probe P2b)
    expect(rs[0]!.outcome).toBe("ALLOW");
  });
});
