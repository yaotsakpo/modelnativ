/** createApp without explicit stores keeps audit and traces bounded (most recent only), and says how many it dropped. */
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedLoyalty } from "@modelnativ/example-loyalty-original";
import { MemoryAudit, MemoryTraces } from "@modelnativ/observability";
import { DEFAULT_MEMORY_AUDIT, DEFAULT_MEMORY_TRACES, createApp, testEnv } from "@modelnativ/runtime";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import { LOYALTY_ROOT } from "../differential/loyalty.lib.ts";

describe("default in-memory audit and traces are bounded", () => {
  it("unit: MemoryAudit and MemoryTraces evict the oldest beyond capacity and count it", () => {
    const a = new MemoryAudit({ capacity: 100 });
    for (let i = 0; i < 1_000; i++) a.write({ traceId: `t${i}` } as never);
    expect(a.records.length).toBeLessThanOrEqual(110);
    expect(a.records.at(-1)!.traceId).toBe("t999");
    expect(a.dropped + a.records.length).toBe(1_000);
    const t = new MemoryTraces({ capacity: 50 });
    for (let i = 0; i < 500; i++) t.put({ traceId: `t${i}` } as never);
    expect(t.traces.size).toBe(50);
    expect(t.get("t499")).toBeDefined();
    expect(t.get("t0")).toBeUndefined();
    expect(t.dropped).toBe(450);
  });

  it("an embedded app serving more requests than the bounds holds at most the bound", { timeout: 300_000 }, async () => {
    const db = new Database(":memory:");
    const n = DEFAULT_MEMORY_AUDIT + 2_000;
    seedLoyalty(db, Array.from({ length: n }, (_, i) => ({ member: `m_${i}`, tenant: "t_a", points: 50, tier: "gold" as const, status: "active" as const })), [{ id: "rw_1", tenant: "t_a", cost: 100, stock: 5, minTier: "bronze" }]);
    const env = testEnv(1);
    const app = createApp({ ...loyaltyC, destinations: () => [] }, join(LOYALTY_ROOT, "c"), { env, db });
    for (let i = 0; i < n; i++)
      await app.engines[0]!.handle({ principal: { subject: `m_${i}`, tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: env.clock.now() + 3.6e6 }, body: { rewardId: "rw_1", quantity: 1 }, idempotencyKey: `mem-${String(i).padStart(8, "0")}` });
    const audit = app.audit as MemoryAudit;
    const traces = app.traces as MemoryTraces;
    expect(audit.records.length).toBeLessThanOrEqual(DEFAULT_MEMORY_AUDIT * 1.1);
    expect(audit.dropped).toBeGreaterThan(0);
    expect(traces.traces.size).toBe(DEFAULT_MEMORY_TRACES);
  });
});
