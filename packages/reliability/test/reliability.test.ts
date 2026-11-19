import { describe, expect, it } from "vitest";
import { SeededRandom, VirtualClock, drive } from "@modelnativ/runtime";
import {
  BreakerOpen,
  CircuitBreaker,
  Deadline,
  DeadlineExceeded,
  FairScheduler,
  Limiter,
  Overloaded,
  RetryableError,
  TIMED_OUT,
  TokenBucket,
  backoffDelay,
  retry,
} from "../src/index.ts";

const env = (seed = 1) => ({ clock: new VirtualClock(0), random: new SeededRandom(seed) });

describe("backoff", () => {
  it("exponential without jitter, capped", () => {
    const p = { maxAttempts: 9, baseMs: 100, maxMs: 1000, jitter: "none" as const };
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(p, n, new SeededRandom(1)))).toEqual([100, 200, 400, 800, 1000]);
  });
  it("full jitter stays within [0, cap] and is reproducible from the seed", () => {
    const p = { maxAttempts: 9, baseMs: 100, maxMs: 1000, jitter: "full" as const };
    const a = [1, 2, 3, 4, 5, 6].map((n, _i, _a, r = new SeededRandom(7)) => n && backoffDelay(p, n, r));
    const seq = (s: number) => {
      const r = new SeededRandom(s);
      return [1, 2, 3, 4, 5, 6].map((n) => backoffDelay(p, n, r));
    };
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
    seq(7).forEach((d, i) => expect(d).toBeLessThanOrEqual(Math.min(1000, 100 * 2 ** i)));
    void a;
  });
});

describe("retry", () => {
  it("retries retryable failures, then succeeds; elapsed virtual time = sum of delays", async () => {
    const e = env();
    const delays: number[] = [];
    let calls = 0;
    const r = await drive(
      retry(
        async () => {
          if (++calls < 3) throw new RetryableError("503", true);
          return "ok";
        },
        { maxAttempts: 5, baseMs: 100, maxMs: 1000, jitter: "none" },
        e,
        { onRetry: (_a, d) => delays.push(d) },
      ),
      e.clock,
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(e.clock.now()).toBe(300);
  });
  it("never retries a non-retryable failure (e.g. a policy refusal)", async () => {
    const e = env();
    let calls = 0;
    await expect(
      drive(retry(async () => (calls++, Promise.reject(new RetryableError("INVARIANT_VIOLATION", false))), { maxAttempts: 5, baseMs: 1, maxMs: 1, jitter: "none" }, e), e.clock),
    ).rejects.toThrow("INVARIANT_VIOLATION");
    expect(calls).toBe(1);
  });
  it("errors without a retryable flag are not retried (fail closed)", async () => {
    const e = env();
    let calls = 0;
    await expect(drive(retry(async () => (calls++, Promise.reject(new Error("?"))), { maxAttempts: 5, baseMs: 1, maxMs: 1, jitter: "none" }, e), e.clock)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("stops at max attempts", async () => {
    const e = env();
    let calls = 0;
    await expect(
      drive(retry(async () => (calls++, Promise.reject(new RetryableError("x", true))), { maxAttempts: 3, baseMs: 10, maxMs: 10, jitter: "none" }, e), e.clock),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });
  it("never sleeps past the deadline", async () => {
    const e = env();
    let calls = 0;
    const dl = new Deadline(e.clock, 250);
    await expect(
      drive(retry(async () => (calls++, Promise.reject(new RetryableError("x", true))), { maxAttempts: 10, baseMs: 100, maxMs: 1000, jitter: "none" }, e, { deadline: dl }), e.clock),
    ).rejects.toThrow();
    expect(calls).toBe(2); // 0 -> fail, sleep 100, -> fail, next delay 200 would cross 250
    expect(e.clock.now()).toBeLessThan(250);
  });
});

describe("deadline", () => {
  it("aborts its signal when it passes and races promises", async () => {
    const e = env();
    const dl = new Deadline(e.clock, 1000);
    const never = new Promise<string>(() => {});
    const r = drive(dl.race(never), e.clock);
    expect(await r).toBe(TIMED_OUT);
    expect(dl.signal.aborted).toBe(true);
    expect(dl.signal.reason).toBeInstanceOf(DeadlineExceeded);
    expect(dl.expired()).toBe(true);
  });
});

describe("rate limiting", () => {
  it("token bucket: burst up to capacity, then Retry-After, then refill", () => {
    const c = new VirtualClock(0);
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1 }, c);
    expect([b.take(), b.take(), b.take()].every((r) => r.ok)).toBe(true);
    expect(b.take()).toEqual({ ok: false, retryAfterMs: 1000 });
    c.advance(1000);
    expect(b.take().ok).toBe(true);
  });
  it("limiter: every rule must admit, and a refusal spends no tokens", () => {
    const c = new VirtualClock(0);
    const l = new Limiter([{ key: "tenant", capacity: 10, refillPerSec: 1 }, { key: "principal", capacity: 1, refillPerSec: 1 }], c);
    expect(l.check({ tenant: "t", principal: "alice" }).ok).toBe(true);
    const r = l.check({ tenant: "t", principal: "alice" });
    expect(r).toMatchObject({ ok: false, rule: "principal" });
    // tenant tokens were not spent by the refused call: 9 left -> bob x9 OK, 10th refused by tenant
    for (let i = 0; i < 9; i++) expect(l.check({ tenant: "t", principal: `bob${i}` }).ok).toBe(true);
    expect(l.check({ tenant: "t", principal: "carol" })).toMatchObject({ ok: false, rule: "tenant" });
  });
  it("limiter key space is bounded", () => {
    const l = new Limiter([{ key: "principal", capacity: 1, refillPerSec: 1 }], new VirtualClock(0), 100);
    for (let i = 0; i < 1000; i++) l.check({ principal: `p${i}` });
    expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(100);
  });
});

describe("fair inference scheduling", () => {
  it("one tenant's burst cannot starve another; concurrency is never exceeded", async () => {
    const c = new VirtualClock(0);
    const s = new FairScheduler({ maxConcurrent: 2, maxQueue: 100, maxQueuePerTenant: 50 }, c);
    let live = 0;
    let peak = 0;
    const job = (t: string) =>
      s.run(t, async () => {
        live++;
        peak = Math.max(peak, live);
        await c.sleep(100);
        live--;
        return t;
      });
    const all = [...Array.from({ length: 20 }, () => job("A")), job("B"), job("B")];
    await drive(Promise.all(all), c);
    expect(peak).toBe(2);
    const firstB = s.grants.indexOf("B");
    expect(firstB).toBeLessThanOrEqual(3); // B is served right after the first A slots, not after all 20
  });
  it("bounded queues reject immediately with a Retry-After estimate", async () => {
    const c = new VirtualClock(0);
    const s = new FairScheduler({ maxConcurrent: 1, maxQueue: 2, maxQueuePerTenant: 1 }, c);
    const hold = () => c.sleep(100);
    const p1 = s.run("A", hold);
    const p2 = s.run("A", hold); // queued (A: 1)
    await expect(s.run("A", hold)).rejects.toMatchObject({ reason: "tenant_queue_full" });
    const p3 = s.run("B", hold); // queued (total 2)
    await expect(s.run("C", hold)).rejects.toBeInstanceOf(Overloaded);
    await drive(Promise.all([p1, p2, p3]), c);
  });
  it("a waiter whose deadline passes is removed and rejected", async () => {
    const c = new VirtualClock(0);
    const s = new FairScheduler({ maxConcurrent: 1, maxQueue: 10, maxQueuePerTenant: 10 }, c);
    const p1 = s.run("A", () => c.sleep(1000));
    const late = s.run("B", async () => "ran", new Deadline(c, 200));
    await expect(drive(late, c)).rejects.toMatchObject({ reason: "deadline" });
    await drive(p1, c);
    expect(s.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe("circuit breaker", () => {
  it("opens after N failures in the window, fails fast, probes once, then closes", async () => {
    const c = new VirtualClock(0);
    const b = new CircuitBreaker({ failures: 3, windowMs: 10_000, openMs: 5_000 }, c);
    const boom = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) await expect(b.run(boom)).rejects.toThrow("down");
    expect(b.current).toBe("open");
    let called = false;
    await expect(b.run(async () => (called = true))).rejects.toBeInstanceOf(BreakerOpen);
    expect(called).toBe(false);
    c.advance(5_000);
    expect(b.current).toBe("half-open");
    await expect(b.run(boom)).rejects.toThrow("down"); // failed probe re-opens
    expect(b.current).toBe("open");
    c.advance(5_000);
    expect(await b.run(async () => "up")).toBe("up");
    expect(b.current).toBe("closed");
    expect(b.transitions).toEqual(["closed->open@0", "open->half-open@5000", "half-open->open@5000", "open->half-open@10000", "half-open->closed@10000"]);
  });
  it("failures outside the window or not counted do not open it", async () => {
    const c = new VirtualClock(0);
    const b = new CircuitBreaker({ failures: 2, windowMs: 1000, openMs: 1000 }, c, (e) => (e as Error).message !== "refused");
    await expect(b.run(() => Promise.reject(new Error("down")))).rejects.toThrow();
    c.advance(2000);
    await expect(b.run(() => Promise.reject(new Error("down")))).rejects.toThrow();
    await expect(b.run(() => Promise.reject(new Error("refused")))).rejects.toThrow();
    expect(b.current).toBe("closed");
  });
});
