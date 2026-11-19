/**
 * Reliability primitives, enforced by the runtime (never by the model).
 *
 * Every primitive takes its time and randomness from the caller's Env (Clock +
 * SeededRandom), so behaviour is deterministic under a VirtualClock and a seed:
 * the same seed gives the same backoff delays, the same admission decisions and
 * the same breaker transitions.
 *
 *   RetryPolicy / retry     transport-level retries with exponential backoff + jitter
 *   Deadline                request deadline -> AbortSignal + remaining budget
 *   TokenBucket / Limiter   keyed rate limits with Retry-After
 *   FairScheduler           max concurrent inference, bounded per-tenant queues, round-robin
 *   CircuitBreaker          closed / open / half-open per dependency
 *
 * What is NEVER retried: policy refusals (they come from the gate, which runs outside
 * every retry loop) and committed effects (commit is not wrapped in retry; the outbox
 * re-delivers with the effect's idempotency key).
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface Random {
  next(): number;
}

// ------------------------------------------------------------ retry

export type RetryPolicy = {
  maxAttempts: number; // total attempts, including the first (1 = no retry)
  baseMs: number;
  maxMs: number;
  /**
   * "full":  delay = random(0, cap)            (AWS full jitter; best spread, may be ~0)
   * "equal": delay = cap/2 + random(0, cap/2)  (never immediate; used for durable dispatch)
   * "none":  delay = cap
   * where cap = min(maxMs, baseMs * 2^(n-1)).
   */
  jitter: "full" | "equal" | "none";
};

export const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseMs: 0, maxMs: 0, jitter: "none" };

/** Delay before attempt `n+1` (n = attempts already made, >= 1). */
export function backoffDelay(p: RetryPolicy, n: number, random: Random): number {
  const cap = Math.min(p.maxMs, p.baseMs * 2 ** (n - 1));
  if (p.jitter === "full") return Math.floor(random.next() * (cap + 1));
  if (p.jitter === "equal") return Math.floor(cap / 2 + random.next() * (cap / 2 + 1));
  return cap;
}

/** An error that says whether retrying could help. Anything without the flag is NOT retried. */
export class RetryableError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: string) {
    super(message);
  }
}
export const isRetryable = (e: unknown): boolean => (e as { retryable?: unknown })?.retryable === true;

export class DeadlineExceeded extends Error {
  readonly retryable = false;
  constructor() {
    super("deadline exceeded");
  }
}

/**
 * Run `fn` up to policy.maxAttempts times. Retries only errors for which `retryable(e)`
 * is true, never after the deadline, and never if a backoff would cross the deadline.
 */
export async function retry<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
  env: { clock: Clock; random: Random },
  opts: { deadline?: Deadline; retryable?: (e: unknown) => boolean; onRetry?: (attempt: number, delayMs: number, e: unknown) => void } = {},
): Promise<T> {
  const can = opts.retryable ?? isRetryable;
  for (let attempt = 1; ; attempt++) {
    if (opts.deadline?.expired()) throw new DeadlineExceeded();
    try {
      return await fn(attempt, opts.deadline?.signal);
    } catch (e) {
      if (attempt >= policy.maxAttempts || !can(e)) throw e;
      const delay = backoffDelay(policy, attempt, env.random);
      if (opts.deadline && delay >= opts.deadline.remaining()) throw e;
      opts.onRetry?.(attempt, delay, e);
      await env.clock.sleep(delay);
    }
  }
}

// ------------------------------------------------------------ deadline

/** A request deadline on the env clock. `signal` aborts when it passes (cancellation). */
export class Deadline {
  private ctrl = new AbortController();
  readonly at: number;
  constructor(private clock: Clock, budgetMs: number) {
    this.at = clock.now() + budgetMs;
    void clock.sleep(budgetMs).then(() => this.ctrl.abort(new DeadlineExceeded()));
  }
  remaining(): number {
    return Math.max(0, this.at - this.clock.now());
  }
  expired(): boolean {
    return this.remaining() <= 0;
  }
  get signal(): AbortSignal {
    return this.ctrl.signal;
  }
  /** Race a promise against the deadline (and an optional tighter timeout). */
  async race<T>(p: Promise<T>, timeoutMs = Infinity): Promise<T | typeof TIMED_OUT> {
    const ms = Math.min(this.remaining(), timeoutMs);
    return Promise.race([p, this.clock.sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)]);
  }
}
export const TIMED_OUT: unique symbol = Symbol("timed-out");

// ------------------------------------------------------------ rate limiting

export type BucketSpec = { capacity: number; refillPerSec: number };

/** Classic token bucket; time from the env clock, refilled lazily on take(). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private spec: BucketSpec, private clock: Clock) {
    this.tokens = spec.capacity;
    this.last = clock.now();
  }
  private refill() {
    const now = this.clock.now();
    this.tokens = Math.min(this.spec.capacity, this.tokens + ((now - this.last) / 1000) * this.spec.refillPerSec);
    this.last = now;
  }
  /** Would `n` tokens be available now? Does not consume. */
  peek(n = 1): { ok: true } | { ok: false; retryAfterMs: number } {
    this.refill();
    if (this.tokens >= n) return { ok: true };
    return { ok: false, retryAfterMs: Math.ceil(((n - this.tokens) / this.spec.refillPerSec) * 1000) };
  }
  take(n = 1): { ok: true } | { ok: false; retryAfterMs: number } {
    const r = this.peek(n);
    if (r.ok) this.tokens -= n;
    return r;
  }
}

export type LimitKey = "tenant" | "principal" | "operation" | "apiKey";
export type LimitRule = BucketSpec & { key: LimitKey };

/**
 * Keyed limiter over several rules. All rules must admit; tokens are only spent when
 * every rule admits (no partial charge). Keys are bounded (LRU) so a flood of distinct
 * keys cannot exhaust memory.
 */
export class Limiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(private rules: LimitRule[], private clock: Clock, private maxKeys = 100_000) {}
  check(ids: Partial<Record<LimitKey, string>>): { ok: true } | { ok: false; rule: LimitKey; retryAfterMs: number } {
    const picked: { rule: LimitRule; bucket: TokenBucket }[] = [];
    for (const rule of this.rules) {
      const id = ids[rule.key];
      if (id === undefined) continue;
      const k = `${rule.key}\u0000${id}`;
      let b = this.buckets.get(k);
      if (!b) {
        if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
        b = new TokenBucket(rule, this.clock);
      } else this.buckets.delete(k);
      this.buckets.set(k, b); // LRU order
      picked.push({ rule, bucket: b });
    }
    // Dry run first so a refusal by one rule does not spend tokens of another.
    let worst: { rule: LimitKey; retryAfterMs: number } | null = null;
    for (const { rule, bucket } of picked) {
      const r = bucket.peek();
      if (!r.ok && (!worst || r.retryAfterMs > worst.retryAfterMs)) worst = { rule: rule.key, retryAfterMs: r.retryAfterMs };
    }
    if (worst) return { ok: false, ...worst };
    for (const { bucket } of picked) bucket.take();
    return { ok: true };
  }
}

// ------------------------------------------------------------ fair inference scheduling

export type SchedulerSpec = { maxConcurrent: number; maxQueue: number; maxQueuePerTenant: number };

export class Overloaded extends Error {
  readonly retryable = false;
  constructor(readonly reason: "queue_full" | "tenant_queue_full" | "deadline", readonly retryAfterMs: number) {
    super(`overloaded: ${reason}`);
  }
}

type Waiter = { tenant: string; grant: () => void; reject: (e: Error) => void; done: boolean };

/**
 * At most `maxConcurrent` inferences run at once. Waiters queue per tenant; slots are
 * granted round-robin across tenants, so one tenant's burst cannot starve another.
 * A full queue rejects immediately with a Retry-After estimate; a waiter whose
 * deadline passes is removed and rejected.
 */
export class FairScheduler {
  private running = 0;
  private queues = new Map<string, Waiter[]>();
  private order: string[] = [];
  private queued = 0;
  /** Exponential moving average of slot hold time, for Retry-After estimates. */
  private avgHoldMs = 1000;
  readonly grants: string[] = []; // tenant per grant, for fairness tests

  constructor(private spec: SchedulerSpec, private clock: Clock) {}

  async run<T>(tenant: string, fn: () => Promise<T>, deadline?: Deadline): Promise<T> {
    await this.acquire(tenant, deadline);
    const t = this.clock.now();
    try {
      return await fn();
    } finally {
      this.avgHoldMs = 0.8 * this.avgHoldMs + 0.2 * Math.max(1, this.clock.now() - t);
      this.release();
    }
  }

  private retryAfter(): number {
    return Math.ceil(((this.queued + 1) / this.spec.maxConcurrent) * this.avgHoldMs);
  }

  private acquire(tenant: string, deadline?: Deadline): Promise<void> {
    if (this.running < this.spec.maxConcurrent && this.queued === 0) {
      this.running++;
      this.grants.push(tenant);
      return Promise.resolve();
    }
    if (this.queued >= this.spec.maxQueue) return Promise.reject(new Overloaded("queue_full", this.retryAfter()));
    const q = this.queues.get(tenant) ?? [];
    if (q.length >= this.spec.maxQueuePerTenant) return Promise.reject(new Overloaded("tenant_queue_full", this.retryAfter()));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { tenant, grant: resolve, reject, done: false };
      q.push(w);
      if (!this.queues.has(tenant)) {
        this.queues.set(tenant, q);
        this.order.push(tenant);
      }
      this.queued++;
      if (deadline)
        void this.clock.sleep(deadline.remaining()).then(() => {
          if (w.done) return;
          w.done = true;
          this.remove(w);
          reject(new Overloaded("deadline", this.retryAfter()));
        });
    });
  }

  private remove(w: Waiter) {
    const q = this.queues.get(w.tenant);
    if (!q) return;
    const i = q.indexOf(w);
    if (i >= 0) {
      q.splice(i, 1);
      this.queued--;
    }
    if (q.length === 0) {
      this.queues.delete(w.tenant);
      this.order = this.order.filter((t) => t !== w.tenant);
    }
  }

  private release() {
    this.running--;
    while (this.running < this.spec.maxConcurrent && this.order.length) {
      const tenant = this.order.shift()!;
      const q = this.queues.get(tenant)!;
      const w = q.shift()!;
      this.queued--;
      if (q.length) this.order.push(tenant); // round-robin: back of the line
      else this.queues.delete(tenant);
      if (w.done) continue;
      w.done = true;
      this.running++;
      this.grants.push(tenant);
      w.grant();
    }
  }

  stats() {
    return { running: this.running, queued: this.queued };
  }
}

// ------------------------------------------------------------ circuit breaker

export type BreakerSpec = { failures: number; windowMs: number; openMs: number };
export type BreakerState = "closed" | "open" | "half-open";

export class BreakerOpen extends Error {
  readonly retryable = false;
  constructor(readonly retryAfterMs: number) {
    super("circuit open");
  }
}

/**
 * Opens after `failures` failures within `windowMs`; while open, calls fail fast with
 * Retry-After. After `openMs`, ONE probe is allowed (half-open): success closes it,
 * failure re-opens it. Only failures the caller classifies as dependency failures count.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failuresAt: number[] = [];
  private openedAt = 0;
  private probing = false;
  readonly transitions: string[] = [];

  constructor(private spec: BreakerSpec, private clock: Clock, private counts: (e: unknown) => boolean = () => true) {}

  get current(): BreakerState {
    if (this.state === "open" && this.clock.now() - this.openedAt >= this.spec.openMs) this.to("half-open");
    return this.state;
  }

  private to(s: BreakerState) {
    if (this.state !== s) this.transitions.push(`${this.state}->${s}@${this.clock.now()}`);
    this.state = s;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const st = this.current;
    if (st === "open") throw new BreakerOpen(this.spec.openMs - (this.clock.now() - this.openedAt));
    if (st === "half-open") {
      if (this.probing) throw new BreakerOpen(1);
      this.probing = true;
    }
    try {
      const r = await fn();
      if (st === "half-open") {
        this.failuresAt = [];
        this.to("closed");
      }
      return r;
    } catch (e) {
      if (this.counts(e)) this.fail(st);
      throw e;
    } finally {
      if (st === "half-open") this.probing = false;
    }
  }

  private fail(st: BreakerState) {
    const now = this.clock.now();
    if (st === "half-open") {
      this.openedAt = now;
      this.to("open");
      return;
    }
    this.failuresAt = this.failuresAt.filter((t) => now - t < this.spec.windowMs);
    this.failuresAt.push(now);
    if (this.failuresAt.length >= this.spec.failures) {
      this.openedAt = now;
      this.to("open");
    }
  }
}
