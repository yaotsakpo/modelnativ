/**
 * Effect executor (PRD §6.E, §21.2, §21.4, §21.5).
 *
 * - commit(): one SQLite transaction does the idempotency check, the domain write
 *   (with an optimistic version check inside the adapter), the effect record and
 *   the outbox rows. Either all of it happens or none of it does.
 * - Dispatcher: delivers outbox rows at-least-once with the effect's idempotency
 *   key, so an idempotent receiver sees one effect even across crashes. Secrets
 *   are resolved from a SecretStore at send time, inside the adapter call; they
 *   never enter the model context, the contract, the audit log or the outbox.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BoundEffect } from "@modelnativ/gate";
import type { RefusalCode } from "@modelnativ/contract-schema";
import { BreakerOpen, CircuitBreaker, backoffDelay, type BreakerSpec, type Random, type RetryPolicy } from "@modelnativ/reliability";

export interface Clock {
  now(): number;
}
export interface Faults {
  check(point: string): void;
}

/** Thrown by adapters (or the executor) to refuse with a stable code; the transaction rolls back. */
export class EffectRefusal extends Error {
  /** `reason`: the application-level code (e.g. the original's "out_of_stock") for in-transaction refusals. */
  constructor(readonly code: RefusalCode, detail: string, readonly reason?: string) {
    super(detail);
  }
}

export type OutboxMessage = { destination: string; payload: Record<string, unknown> };

export interface EffectAdapter {
  tool: string;
  /** Runs inside the transaction. Must check binding.expectedVersion and current-state invariants. */
  apply(
    db: Database.Database,
    args: Record<string, string | number>,
    binding: BoundEffect["binding"],
    ctx: { effectId: string; now: number },
  ): { result: Record<string, unknown>; outbox?: OutboxMessage[] };
}

export interface SecretStore {
  get(name: string): string;
}
export class MemorySecretStore implements SecretStore {
  constructor(private secrets: Record<string, string>) {}
  get(name: string) {
    const v = this.secrets[name];
    if (v === undefined) throw new Error(`secret not found: ${name}`);
    return v;
  }
  rotate(name: string, value: string) {
    this.secrets[name] = value;
  }
}
/** Reads MN_SECRET_<NAME> from the process environment (stand-in for a secret manager). */
export class EnvSecretStore implements SecretStore {
  get(name: string) {
    const key = `MN_SECRET_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const v = process.env[key];
    if (!v) throw new Error(`secret not configured: ${key}`);
    return v;
  }
}

export interface Destination {
  name: string;
  /** Secret names this destination needs. Resolved per call, so rotation needs no recompile. */
  secrets: string[];
  send(payload: Record<string, unknown>, ctx: { idempotencyKey: string; secrets: Record<string, string> }): Promise<{ externalId: string }>;
}

export const EXECUTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS mn_operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mn_effects (
  scoped_key TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mn_outbox (
  id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  external_id TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS mn_outbox_pending ON mn_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS mn_claims (
  scoped_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','released')),
  lease_until INTEGER NOT NULL,
  outcome_json TEXT,
  updated_at INTEGER NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mn_pending (
  token_hash TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  principal TEXT NOT NULL,
  operation TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','resumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

/** Create the executor tables, and add columns introduced later to tables created by older versions. */
export function ensureExecutorSchema(db: Database.Database) {
  db.exec(EXECUTOR_SCHEMA);
  const cols = new Set((db.prepare(`PRAGMA table_info(mn_outbox)`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("lease_owner")) db.exec(`ALTER TABLE mn_outbox ADD COLUMN lease_owner TEXT`);
  if (!cols.has("lease_until")) db.exec(`ALTER TABLE mn_outbox ADD COLUMN lease_until INTEGER`);
  const claimCols = new Set((db.prepare(`PRAGMA table_info(mn_claims)`).all() as { name: string }[]).map((c) => c.name));
  if (!claimCols.has("terminal")) db.exec(`ALTER TABLE mn_claims ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0`);
}

export type PendingClarification = {
  tokenHash: string;
  tenant: string;
  principal: string;
  operation: string;
  contractHash: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
  requestHash: string;
  round: number;
  createdAt: number;
  expiresAt: number;
};

/** The final answer of an attempt that ended without a committed effect, kept so concurrent duplicates converge on it. */
export type SettledOutcome = { outcome: string; code?: string; detail?: string; reason?: string; retryAfterMs?: number };

/**
 * The state of one idempotency key, read or decided atomically in the shared database.
 *   claimed    this attempt now owns the key (fresh, or taken over from a released or expired claim)
 *   committed  an effect was committed under this key: return it
 *   conflict   the key is bound to a different request
 *   inflight   another attempt owns the key and its lease is live
 *   settled    the owner finished without an effect; its answer is attached. From claimKey only
 *              when the answer is TERMINAL (settled-outcome mode): the key then answers forever
 *   free       (peek only) no claim and no effect
 */
export type KeyState =
  | { kind: "claimed"; takeover: boolean }
  | { kind: "committed"; prior: { effectId: string; requestHash: string; result: Record<string, unknown> } }
  | { kind: "conflict" }
  | { kind: "inflight"; owner: string; leaseUntil: number }
  | { kind: "settled"; owner: string; outcome: SettledOutcome }
  | { kind: "free" };

type ClaimRow = { request_hash: string; owner: string; status: "pending" | "released"; lease_until: number; outcome_json: string | null; terminal: number; updated_at: number };

/** Idempotency keys are scoped to tenant, principal and operation: one caller's key never collides with another's. */
export function scopedKey(tenant: string, principal: string, operation: string, key: string): string {
  return `${tenant}\u0000${principal}\u0000${operation}\u0000${key}`;
}

function hashArgs(e: BoundEffect): string {
  const b = e.binding;
  const body = JSON.stringify([e.tool, Object.entries(e.args).sort(), b.operation, b.principal, b.tenant, b.resourceKey]);
  return createHash("sha256").update(body).digest("hex");
}

export type CommitResult =
  | { status: "committed"; effectId: string; result: Record<string, unknown> }
  | { status: "duplicate"; effectId: string; result: Record<string, unknown> }
  | { status: "refused"; code: RefusalCode; detail: string; reason?: string };

class Rollback extends Error {
  constructor(readonly outcome: CommitResult) {
    super("rollback");
  }
}

export class Executor {
  private adapters = new Map<string, EffectAdapter>();
  /** Statements are prepared once per executor (all executor SQL is constant). */
  private statements = new Map<string, Database.Statement>();
  private stmt(sql: string): Database.Statement {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  constructor(
    readonly db: Database.Database,
    private clock: Clock,
    private faults: Faults,
    private newId: (prefix: string) => string,
    adapters: EffectAdapter[],
  ) {
    ensureExecutorSchema(db);
    for (const a of adapters) this.adapters.set(a.tool, a);
  }

  get tools(): string[] {
    return [...this.adapters.keys()];
  }

  /** Persist intent before anything effectful (§21.5). */
  recordOperation(operationId: string, operation: string, status: string, detail?: string) {
    const now = this.clock.now();
    this
      .stmt(
        `INSERT INTO mn_operations(operation_id, operation, status, detail, created_at, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, updated_at=excluded.updated_at`,
      )
      .run(operationId, operation, status, detail ?? null, now, now);
  }

  /**
   * Shadow execution: run the real adapter (with its version and invariant checks)
   * inside a transaction that is ALWAYS rolled back. No row, no outbox message, no
   * external call survives. Used to compare against an authoritative legacy path.
   */
  dryRun(effect: BoundEffect): CommitResult {
    const adapter = this.adapters.get(effect.tool);
    if (!adapter) return { status: "refused", code: "UNSUPPORTED_EFFECT", detail: `no adapter for ${effect.tool}` };
    const tx = this.db.transaction(() => {
      try {
        const { result } = adapter.apply(this.db, effect.args, effect.binding, { effectId: "eff_shadow", now: this.clock.now() });
        throw new Rollback({ status: "committed", effectId: "eff_shadow", result });
      } catch (e) {
        if (e instanceof Rollback) throw e;
        if (e instanceof EffectRefusal) throw new Rollback({ status: "refused", code: e.code, detail: e.message });
        throw e;
      }
    });
    try {
      tx.immediate();
    } catch (e) {
      if (e instanceof Rollback) return e.outcome;
      throw e;
    }
    throw new Error("unreachable: dry run committed");
  }

  /** Persist a pending clarification. Only the token's hash is stored. */
  createPending(p: PendingClarification) {
    this
      .stmt(
        `INSERT INTO mn_pending(token_hash, tenant, principal, operation, contract_hash, idempotency_key, request_json, request_hash, round, status, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(p.tokenHash, p.tenant, p.principal, p.operation, p.contractHash, p.idempotencyKey, JSON.stringify(p.request), p.requestHash, p.round, p.createdAt, p.expiresAt);
  }

  /**
   * Atomically claim a pending clarification for resumption. Succeeds at most once, and only
   * for the same tenant, principal, operation and contract version, before expiry.
   * Anything else (unknown, foreign, expired, used, contract changed) returns undefined.
   */
  claimPending(tokenHash: string, who: { tenant: string; principal: string; operation: string; contractHash: string; now: number }): PendingClarification | undefined {
    const tx = this.db.transaction(() => {
      const u = this
        .stmt(
          `UPDATE mn_pending SET status='resumed' WHERE token_hash=? AND status='pending' AND tenant=? AND principal=? AND operation=? AND contract_hash=? AND expires_at > ?`,
        )
        .run(tokenHash, who.tenant, who.principal, who.operation, who.contractHash, who.now);
      if (u.changes !== 1) return undefined;
      const r = this.stmt(`SELECT * FROM mn_pending WHERE token_hash=?`).get(tokenHash) as Record<string, unknown>;
      return {
        tokenHash,
        tenant: String(r.tenant),
        principal: String(r.principal),
        operation: String(r.operation),
        contractHash: String(r.contract_hash),
        idempotencyKey: String(r.idempotency_key),
        request: JSON.parse(String(r.request_json)),
        requestHash: String(r.request_hash),
        round: Number(r.round),
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      } satisfies PendingClarification;
    });
    return tx.immediate();
  }

  /**
   * Claim an idempotency key for one attempt, atomically (BEGIN IMMEDIATE), so that across
   * processes sharing this database at most one attempt evaluates a key at a time. Does not
   * depend on any in-process queue. A pending claim whose lease has expired (its owner crashed
   * or stalled) is taken over. A stale owner can still reach `commit`, where the in-transaction
   * duplicate check keeps it to one effect; its non-ALLOW decisions are discarded by the engine.
   */
  claimKey(key: string, requestHash: string, owner: string, leaseMs: number, retentionMs = Number.MAX_SAFE_INTEGER): KeyState {
    const tx = this.db.transaction((): KeyState => {
      const now = this.clock.now();
      const prior = this.lookup(key);
      if (prior) return prior.requestHash === requestHash ? { kind: "committed", prior } : { kind: "conflict" };
      let row = this.stmt(`SELECT request_hash, owner, status, lease_until, outcome_json, terminal, updated_at FROM mn_claims WHERE scoped_key = ?`).get(key) as ClaimRow | undefined;
      // Past retention, a released key is forgotten: the request is a new attempt (any payload).
      if (row && row.status === "released" && row.updated_at + retentionMs <= now) {
        this.stmt(`DELETE FROM mn_claims WHERE scoped_key = ?`).run(key);
        row = undefined;
      }
      if (row && row.request_hash !== requestHash) return { kind: "conflict" };
      if (!row) {
        this.stmt(`INSERT INTO mn_claims(scoped_key, request_hash, owner, status, lease_until, outcome_json, updated_at) VALUES (?,?,?,'pending',?,NULL,?)`).run(key, requestHash, owner, now + leaseMs, now);
        return { kind: "claimed", takeover: false };
      }
      if (row.status === "pending" && row.owner !== owner && row.lease_until > now) return { kind: "inflight", owner: row.owner, leaseUntil: row.lease_until };
      // A terminal answer is never re-evaluated: same key, same payload, same answer.
      if (row.status === "released" && row.terminal) return { kind: "settled", owner: row.owner, outcome: JSON.parse(row.outcome_json ?? "{}") };
      this.stmt(`UPDATE mn_claims SET owner = ?, status = 'pending', lease_until = ?, outcome_json = NULL, terminal = 0, updated_at = ? WHERE scoped_key = ?`).run(owner, now + leaseMs, now, key);
      return { kind: "claimed", takeover: row.status === "pending" && row.owner !== owner };
    });
    return tx.immediate();
  }

  /** Read a key's state without changing it (used while waiting on another attempt). */
  peekKey(key: string, requestHash: string): KeyState {
    const prior = this.lookup(key);
    if (prior) return prior.requestHash === requestHash ? { kind: "committed", prior } : { kind: "conflict" };
    const row = this.stmt(`SELECT request_hash, owner, status, lease_until, outcome_json, terminal, updated_at FROM mn_claims WHERE scoped_key = ?`).get(key) as ClaimRow | undefined;
    if (!row) return { kind: "free" };
    if (row.request_hash !== requestHash) return { kind: "conflict" };
    if (row.status === "released") return { kind: "settled", owner: row.owner, outcome: JSON.parse(row.outcome_json ?? "{}") };
    return { kind: "inflight", owner: row.owner, leaseUntil: row.lease_until };
  }

  /** Whether `owner` still holds a live-or-expired-but-not-taken-over claim on the key. */
  ownsKey(key: string, owner: string): boolean {
    const r = this.stmt(`SELECT 1 FROM mn_claims WHERE scoped_key = ? AND owner = ? AND status = 'pending'`).get(key, owner);
    return r !== undefined;
  }

  /**
   * The owner finished without committing: publish its answer to waiters. A non-terminal answer
   * frees the key for later retries; a `terminal` one (settled-outcome mode) answers forever.
   */
  releaseKey(key: string, owner: string, outcome: SettledOutcome, terminal = false) {
    this.stmt(`UPDATE mn_claims SET status = 'released', outcome_json = ?, terminal = ?, updated_at = ? WHERE scoped_key = ? AND owner = ? AND status = 'pending'`).run(JSON.stringify(outcome), terminal ? 1 : 0, this.clock.now(), key, owner);
  }

  /** Delete released claims (settled or not) last updated before `before`. Returns how many. */
  pruneClaims(before: number): number {
    return this.stmt(`DELETE FROM mn_claims WHERE status = 'released' AND updated_at < ?`).run(before).changes;
  }

  /** A committed effect under this key, if any. Used before inference, so a retry costs no model call. */
  lookup(key: string): { effectId: string; requestHash: string; result: Record<string, unknown> } | undefined {
    const r = this.stmt(`SELECT effect_id, request_hash, result_json FROM mn_effects WHERE scoped_key = ?`).get(key) as
      | { effect_id: string; request_hash: string; result_json: string }
      | undefined;
    return r && { effectId: r.effect_id, requestHash: r.request_hash, result: JSON.parse(r.result_json) };
  }

  commit(effect: BoundEffect, opts: { idempotencyKey: string; requestHash: string; operationId: string; fenceOwner?: string }): CommitResult {
    const adapter = this.adapters.get(effect.tool);
    if (!adapter) return { status: "refused", code: "UNSUPPORTED_EFFECT", detail: `no adapter for ${effect.tool}` };
    if (!opts.idempotencyKey) return { status: "refused", code: "SCHEMA_INVALID", detail: "idempotency key required" };
    const b = effect.binding;
    const key = scopedKey(b.tenant, b.principal, b.operation, opts.idempotencyKey);
    const argsHash = hashArgs(effect);
    const operationId = opts.operationId;

    const tx = this.db.transaction((): CommitResult => {
      // Transactional backstop for concurrent duplicates that both passed the pre-inference lookup.
      const prior = this.lookup(key);
      if (prior) {
        if (prior.requestHash !== opts.requestHash)
          throw new EffectRefusal("REPLAY_DETECTED", "idempotency key reused for a different request");
        return { status: "duplicate", effectId: prior.effectId, result: prior.result };
      }
      // Settled-outcome mode: only the current owner of a pending claim may commit. Without this a
      // stale owner (lease taken over) could commit after the key settled on a terminal refusal.
      if (opts.fenceOwner !== undefined) {
        const c = this.stmt(`SELECT owner, status FROM mn_claims WHERE scoped_key = ?`).get(key) as { owner: string; status: string } | undefined;
        if (c && (c.owner !== opts.fenceOwner || c.status !== "pending"))
          throw new EffectRefusal("IDEMPOTENCY_IN_PROGRESS", "this attempt no longer owns the idempotency key");
      }
      const effectId = this.newId("eff");
      const now = this.clock.now();
      const { result, outbox } = adapter.apply(this.db, effect.args, b, { effectId, now });
      this
        .stmt(`INSERT INTO mn_effects(scoped_key, effect_id, operation_id, tool, args_hash, request_hash, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(key, effectId, operationId, effect.tool, argsHash, opts.requestHash, JSON.stringify(result), now);
      const ins = this.stmt(
        `INSERT INTO mn_outbox(id, effect_id, destination, payload_json, status, next_attempt_at) VALUES (?,?,?,?, 'pending', ?)`,
      );
      for (const m of outbox ?? []) ins.run(this.newId("obx"), effectId, m.destination, JSON.stringify(m.payload), now);
      // The effect row now answers for the key. (No ownership fence is needed here: a stale owner that
      // reaches this transaction after the new owner committed is turned into a duplicate just above,
      // and one that commits first makes the new owner's commit a duplicate. One effect either way.)
      this.stmt(`DELETE FROM mn_claims WHERE scoped_key = ?`).run(key);
      this.faults.check("executor.beforeCommit"); // a db failure here must roll everything back
      return { status: "committed", effectId, result };
    });

    try {
      return tx.immediate();
    } catch (e) {
      if (e instanceof EffectRefusal) return { status: "refused", code: e.code, detail: e.message, ...(e.reason ? { reason: e.reason } : {}) };
      throw e;
    }
  }
}

export const DEFAULT_OUTBOX_LEASE_MS = 60_000;

export type DispatchReport = {
  delivered: number;
  retried: number;
  dead: number;
  deferred?: number;
  /** Sent, but our lease had expired and another dispatcher owned the row by the time we recorded it. */
  leaseLost?: number;
};

export type DispatcherOptions = {
  /** Durable retry policy. Default: 5 attempts, 500 ms base, 60 s cap, equal jitter (never immediate). */
  policy?: RetryPolicy;
  /** Jitter source. Pass the env's SeededRandom so dispatch timing is reproducible. */
  random?: Random;
  /** Per-destination circuit breaker: while open, messages are deferred without spending an attempt. */
  breaker?: BreakerSpec;
  /**
   * How long a dispatcher owns a row it is sending. Another dispatcher (another process) may
   * take the row over only after this; a send that takes longer can be duplicated (at-least-once).
   */
  leaseMs?: number;
  /** This dispatcher's lease identity (default: random per instance). */
  owner?: string;
};

export const DEFAULT_DISPATCH: RetryPolicy = { maxAttempts: 5, baseMs: 500, maxMs: 60_000, jitter: "equal" };

export class Dispatcher {
  private destinations = new Map<string, Destination>();
  /** Lease identity of this dispatcher (one per process in practice). */
  readonly owner: string;
  private leaseMs: number;
  /** The drain in progress, if any: overlapping drain() calls join it instead of sending twice. */
  private running: Promise<DispatchReport> | null = null;
  private breakers = new Map<string, CircuitBreaker>();
  private policy: RetryPolicy;
  private random: Random;
  constructor(
    private db: Database.Database,
    private clock: Clock & { sleep?(ms: number): Promise<void> },
    private faults: Faults,
    private secrets: SecretStore,
    destinations: Destination[],
    private opts: DispatcherOptions = {},
  ) {
    ensureExecutorSchema(db);
    for (const d of destinations) this.destinations.set(d.name, d);
    this.owner = opts.owner ?? `disp_${randomUUID()}`;
    this.leaseMs = opts.leaseMs ?? DEFAULT_OUTBOX_LEASE_MS;
    this.policy = opts.policy ?? DEFAULT_DISPATCH;
    this.random = opts.random ?? { next: () => 0.5 }; // deterministic default; production passes env.random
  }

  private breakerFor(name: string): CircuitBreaker | null {
    if (!this.opts.breaker) return null;
    let b = this.breakers.get(name);
    if (!b) {
      // A non-retryable rejection (e.g. 400) is the request's fault, not the dependency's.
      b = new CircuitBreaker(this.opts.breaker, { now: () => this.clock.now(), sleep: async () => {} }, (e) => (e as { retryable?: unknown })?.retryable !== false && (e as { kind?: string })?.kind !== "crash");
      this.breakers.set(name, b);
    }
    return b;
  }

  /**
   * Deliver every due row once. Single-flight per dispatcher: a call while a drain is running
   * returns that drain. Across processes, each row is leased (lease_owner, lease_until) before it
   * is sent, so two dispatchers never send the same row at the same time; a row whose lease
   * expired (its dispatcher crashed or stalled) is taken over and sent again: at-least-once,
   * never exactly-once (receivers de-duplicate by the effect id sent as the idempotency key).
   * An injected crash propagates (the "process dies"); the row keeps its lease until expiry.
   */
  drain(): Promise<DispatchReport> {
    if (this.running) return this.running;
    const run = this.drainOnce().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async drainOnce(): Promise<DispatchReport> {
    const report: DispatchReport = { delivered: 0, retried: 0, dead: 0 };
    const now0 = this.clock.now();
    const due = this.db
      .prepare(
        `SELECT id, effect_id, destination, payload_json, attempts FROM mn_outbox
          WHERE status='pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?) ORDER BY id`,
      )
      .all(now0, now0, this.owner) as { id: string; effect_id: string; destination: string; payload_json: string; attempts: number }[];
    const claim = this.db.prepare(
      `UPDATE mn_outbox SET lease_owner = ?, lease_until = ? WHERE id = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)`,
    );
    for (const row of due) {
      // Lease the row; another dispatcher may have taken it since the SELECT.
      const now = this.clock.now();
      if (claim.run(this.owner, now + this.leaseMs, row.id, now, this.owner).changes !== 1) continue;
      const dest = this.destinations.get(row.destination);
      try {
        if (!dest) throw new Error(`unknown destination ${row.destination}`);
        this.faults.check("outbox.beforeSend");
        const secrets = Object.fromEntries(dest.secrets.map((s) => [s, this.secrets.get(s)]));
        const send = () => dest.send(JSON.parse(row.payload_json), { idempotencyKey: row.effect_id, secrets });
        const breaker = this.breakerFor(dest.name);
        const { externalId } = breaker ? await breaker.run(send) : await send();
        this.faults.check("outbox.afterSend"); // crash window: receiver has it, we have not recorded it
        // Fenced by the lease: if it expired and another dispatcher took the row, it decides.
        const u = this.db
          .prepare(`UPDATE mn_outbox SET status='delivered', external_id=?, attempts=attempts+1, last_error=NULL, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?`)
          .run(externalId, row.id, this.owner);
        if (u.changes === 1) report.delivered++;
        else report.leaseLost = (report.leaseLost ?? 0) + 1;
      } catch (e) {
        if ((e as { kind?: string }).kind === "crash") throw e;
        if (e instanceof BreakerOpen) {
          // The destination is failing: defer without spending an attempt.
          this.db.prepare(`UPDATE mn_outbox SET next_attempt_at=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?`).run(this.clock.now() + e.retryAfterMs, row.id, this.owner);
          report.deferred = (report.deferred ?? 0) + 1; // present only when something was deferred
          continue;
        }
        const attempts = row.attempts + 1;
        // Never record secret values: errors are reduced to their class and message, scrubbed.
        const msg = scrub(String((e as Error).message ?? e), this.secretValues(dest));
        const permanent = (e as { retryable?: unknown }).retryable === false;
        if (permanent || attempts >= this.policy.maxAttempts) {
          this.db.prepare(`UPDATE mn_outbox SET status='dead', attempts=?, last_error=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?`).run(attempts, msg, row.id, this.owner);
          report.dead++;
        } else {
          const delay = backoffDelay(this.policy, attempts, this.random);
          this.db
            .prepare(`UPDATE mn_outbox SET attempts=?, next_attempt_at=?, last_error=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?`)
            .run(attempts, this.clock.now() + delay, msg, row.id, this.owner);
          report.retried++;
        }
      }
    }
    return report;
  }

  private secretValues(dest: Destination | undefined): string[] {
    if (!dest) return [];
    return dest.secrets.flatMap((s) => {
      try {
        return [this.secrets.get(s)];
      } catch {
        return [];
      }
    });
  }
}

export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  return out;
}
