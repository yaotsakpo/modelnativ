/**
 * The execution kernel for one operation (PRD §21.1):
 *
 *   authenticate -> validate input -> idempotency lookup -> per-resource actor
 *   -> read facts (minted through PSAP) -> model proposal (budgeted)
 *   -> gate -> transactional commit + outbox -> audit + trace
 *
 * On STALE_STATE the whole decision is re-made once on fresh state; the old
 * proposal is never replayed (§21.1.6). Every yield point is a place a test
 * scheduler can interleave concurrent operations.
 */
import { Ajv, type ValidateFunction } from "@modelnativ/contract-schema/ajv";
import type { CompiledContract } from "@modelnativ/contract-compiler";
import { canonicalJson as canonical, type Principal, type RefusalCode, type ReviewCode } from "@modelnativ/contract-schema";
import { Evidence, checkPrincipal, evaluateProposal, type GateDecision } from "@modelnativ/gate";
import { hashModelInput, type ModelAdapter, type ModelInput } from "@modelnativ/model-adapter";
import { scopedKey, type CommitResult, type Executor, type KeyState, type SettledOutcome } from "@modelnativ/effect-executor";
import { hashPrincipal, sha256, type AuditRecord, type AuditSink, type TraceRecord, type TraceStore } from "@modelnativ/observability";
import { performance } from "node:perf_hooks";
import {
  BreakerOpen,
  CircuitBreaker,
  Deadline,
  DeadlineExceeded,
  NO_RETRY,
  Overloaded,
  RetryableError,
  TIMED_OUT,
  isRetryable,
  retry,
  type FairScheduler,
  type Limiter,
} from "@modelnativ/reliability";
import { InjectedFault, ReplayedFailure, type Env } from "./env.ts";


export const RUNTIME_VERSION = "0.0.1";

export type ReadTool = {
  name: string;
  /** Read-only, tenant-scoped. Returns an object keyed by predicate, or null when nothing is found. */
  read(args: Record<string, unknown>, ctx: { tenant: string }): Promise<Record<string, unknown> | null>;
};

export type OperationRequest = {
  principal: Principal | null;
  body: unknown;
  idempotencyKey: string | null;
};

export type OperationResult = {
  traceId: string;
  operationId: string;
  outcome: "ALLOW" | "REFUSE" | "REVIEW" | "CLARIFY";
  /** The contract's application-level reason code for the rule that decided (when declared). */
  reason?: string;
  /** Present when outcome is CLARIFY. Nothing was executed; resume with resume(). */
  clarification?: Clarification;
  code?: RefusalCode | ReviewCode;
  detail?: string;
  effect?: { effectId: string; status: "committed" | "duplicate"; result: Record<string, unknown> };
  httpStatus: number;
  /** For RATE_LIMITED / OVERLOADED / MODEL_UNAVAILABLE: when a retry may succeed (Retry-After). */
  retryAfterMs?: number;
  /**
   * Present only when persisting the operation's records failed AFTER the outcome was decided
   * (and, for ALLOW, committed). The outcome above stands; these records are missing.
   */
  observability?: { failed: ("audit" | "trace" | "status")[] };
  /**
   * Present when this answer was not evaluated by this request but taken from the attempt that
   * owned the idempotency key (a concurrent duplicate, or a settled key): that attempt's operation id.
   */
  answeredBy?: string;
};

/** An audit/trace/status write that failed after the outcome was decided. Never changes the outcome. */
export type ObservabilityFailure = { stage: "audit" | "trace" | "status"; error: unknown; traceId: string; operationId: string; operation: string; committed: boolean };

/** The part of the executor the engine uses; a replay committer implements it from a trace. */
export type Committer = Pick<Executor, "lookup" | "commit" | "recordOperation"> &
  Partial<Pick<Executor, "dryRun" | "createPending" | "claimPending" | "claimKey" | "peekKey" | "releaseKey" | "ownsKey">>;

/**
 * Durable idempotency claims. Correctness does not depend on the per-resource queue: the claim
 * lives in the shared database, so concurrent duplicates converge across processes.
 *   leaseMs  how long an owner may hold a key before another attempt may take it over (crash recovery)
 *   waitMs   how long a duplicate waits for the owner's answer before IDEMPOTENCY_IN_PROGRESS
 *   pollMs   how often a waiting duplicate re-reads the key
 */
export type IdempotencyOptions = {
  leaseMs?: number;
  waitMs?: number;
  pollMs?: number;
  maxPollMs?: number;
  maxWaiters?: number;
  /**
   * What a key remembers when an attempt ends WITHOUT a committed effect:
   *   "release"   (default) nothing: a later retry with the same key re-evaluates
   *   "terminal"  terminal business answers (business refusals, REVIEW) are settled: every later
   *               request with the same key and payload gets the same answer, and a stale owner
   *               cannot commit after it. Transient failures and CLARIFY stay retryable.
   * "terminal" changes client-visible retry semantics (a new attempt needs a new key).
   */
  settle?: "release" | "terminal";
  /** How long a released key (settled answer or not) is remembered; afterwards a retry is a new attempt. */
  retentionMs?: number;
};

/** Refusals that describe the infrastructure, not the business decision: retryable, never settled. */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(["EXECUTION_FAILED", "DEADLINE_EXCEEDED", "MODEL_TIMEOUT", "MODEL_ERROR", "MODEL_UNAVAILABLE", "RATE_LIMITED", "OVERLOADED", "BUDGET_EXCEEDED", "STALE_STATE", "IDEMPOTENCY_IN_PROGRESS"]);
const isTerminal = (r: { outcome: string; code?: string }) => r.outcome === "REVIEW" || (r.outcome === "REFUSE" && !TRANSIENT_CODES.has(r.code ?? ""));
/**
 *   pollMs / maxPollMs  first poll interval, doubled after each poll up to maxPollMs
 *   maxWaiters          duplicates waiting at once per engine; beyond it a duplicate gets
 *                       IDEMPOTENCY_IN_PROGRESS immediately (backpressure, retryable)
 * Waiting never holds the per-resource queue slot, and never outlives the request deadline.
 */
export const IDEMPOTENCY_DEFAULTS = { leaseMs: 30_000, waitMs: 5_000, pollMs: 25, maxPollMs: 200, maxWaiters: 256, retentionMs: 7 * 86_400_000 } as const;
type IdemOpts = { leaseMs: number; waitMs: number; pollMs: number; maxPollMs: number; maxWaiters: number; retentionMs: number; settle?: "release" | "terminal" };

export type Clarification = {
  /** Opaque, single-use; only its hash is stored. Present the question, send back the answer with this token. */
  token: string;
  question: string;
  choices: { id: string; text: string }[];
  allowText: boolean;
  expiresAt: number;
  round: number;
};

export type ResumeRequest = {
  principal: Principal | null;
  token: string;
  answer: { choice?: string; text?: string };
};

export type EngineDeps = {
  env: Env;
  contract: CompiledContract;
  /** Required unless the contract's decision source is "field" (no inference at all). */
  model?: ModelAdapter;
  tools: ReadTool[];
  executor: Committer;
  audit: AuditSink;
  traces: TraceStore;
  /** Serialize operations per resource (actor). Tests turn this off to prove the DB check alone holds. */
  serialize?: boolean;
  idempotency?: IdempotencyOptions;
  /** Process-wide rate limits (runtime config, shared by all operations). */
  limiter?: Limiter;
  /** Process-wide inference scheduler: max concurrent inference, fair per-tenant queues. */
  scheduler?: FairScheduler;
  /** Model circuit breaker; if absent and the contract declares one, the engine creates its own. */
  modelBreaker?: CircuitBreaker;
  seed?: number | null;
  /** Called (never throwing into the request) when an audit, trace or status write fails. */
  onObservabilityFailure?: (f: ObservabilityFailure) => void;
};

class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  private depth = new Map<string, number>();
  size(key: string) {
    return this.depth.get(key) ?? 0;
  }
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.depth.set(key, this.size(key) + 1);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      const d = this.size(key) - 1;
      if (d === 0) {
        this.depth.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else this.depth.set(key, d);
    }
  }
}

const HTTP: Partial<Record<string, number>> = {
  UNAUTHENTICATED: 401,
  CAPABILITY_MISSING: 403,
  TENANT_VIOLATION: 403,
  SCHEMA_INVALID: 400,
  STALE_STATE: 409,
  REPLAY_DETECTED: 409,
  OVERLOADED: 429,
  MODEL_TIMEOUT: 503,
  MODEL_ERROR: 503,
  EXECUTION_FAILED: 503,
  BUDGET_EXCEEDED: 503,
  RATE_LIMITED: 429,
  DEADLINE_EXCEEDED: 504,
  MODEL_UNAVAILABLE: 503,
  IDEMPOTENCY_IN_PROGRESS: 409,
};

type Refusal = { refuse: RefusalCode; detail: string; retryAfterMs?: number };

/** Map a transport-level failure to a stable refusal code. */
function transportRefusal(e: unknown, fallback: RefusalCode, what: string): Refusal {
  if (e instanceof DeadlineExceeded) return { refuse: "DEADLINE_EXCEEDED", detail: `${what}: deadline exceeded` };
  if (e instanceof Overloaded) return { refuse: "OVERLOADED", detail: `${what}: ${e.message}`, retryAfterMs: e.retryAfterMs };
  if (e instanceof BreakerOpen) return { refuse: "MODEL_UNAVAILABLE", detail: `${what}: circuit open`, retryAfterMs: e.retryAfterMs };
  const code = (e as { code?: string })?.code;
  if (code === "MODEL_TIMEOUT" || (e instanceof InjectedFault && e.kind === "timeout")) return { refuse: "MODEL_TIMEOUT", detail: `${what}: ${(e as Error).message}` };
  return { refuse: fallback, detail: `${what}: ${(e as Error).message}` };
}

export class Engine {
  private inputValidator: ValidateFunction;
  private queue = new KeyedQueue();
  private tools: Map<string, ReadTool>;

  private breaker: CircuitBreaker | null;

  /** One poller per (key, owner) in this process; waiters for the same key share it. */
  private pollers = new Map<string, { refs: number; done: Promise<KeyState> }>();
  private waiting = 0;

  /** Waiters currently waiting on another attempt's idempotency claim (for observation and tests). */
  get idempotencyWaiters(): number {
    return this.waiting;
  }

  /**
   * Wait (outside any queue slot) until the key is no longer held by `owner` with a live lease,
   * or until `until`. Polls with exponential backoff; concurrent waiters share one poller.
   */
  private async awaitKey(key: string, hash: string, owner: string, until: number, o: IdemOpts): Promise<KeyState | "timeout" | "busy"> {
    const { env, executor } = this.d;
    if (this.waiting >= o.maxWaiters) return "busy";
    this.waiting++;
    const pk = `${key}\u0000${owner}`;
    let entry = this.pollers.get(pk);
    if (!entry) {
      const e = { refs: 0, done: null as unknown as Promise<KeyState> };
      e.done = (async (): Promise<KeyState> => {
        let interval = o.pollMs;
        for (;;) {
          await env.scheduler.yield("idempotency.wait");
          await env.clock.sleep(interval);
          interval = Math.min(interval * 2, o.maxPollMs);
          const s = this.timed("db.idempotencyPeek", () => executor.peekKey!(key, hash));
          if (s.kind !== "inflight" || s.owner !== owner || s.leaseUntil <= env.clock.now() || e.refs === 0) return s;
        }
      })().finally(() => this.pollers.delete(pk));
      this.pollers.set(pk, (entry = e));
    }
    entry.refs++;
    try {
      const remaining = Math.max(0, until - env.clock.now());
      return await Promise.race([entry.done, env.clock.sleep(remaining).then(() => "timeout" as const)]);
    } finally {
      entry.refs--;
      this.waiting--;
    }
  }

  /** The committed effect for this caller's idempotency key, if any (e.g. before a host falls back to legacy code). */
  findCommitted(principal: Principal, idempotencyKey: string): { effectId: string; result: Record<string, unknown> } | undefined {
    const p = this.d.executor.lookup(scopedKey(principal.tenant, principal.subject, this.d.contract.name, idempotencyKey));
    return p && { effectId: p.effectId, result: p.result };
  }

  constructor(private d: EngineDeps) {
    // A pure model contract needs a model. A hybrid contract may run without one: structured requests
    // work, and free-text requests are refused (MODEL_UNAVAILABLE) instead of guessed.
    if ((d.contract.source.spec.decision.source?.mode ?? "model") === "model" && !d.model)
      throw new Error(`contract ${d.contract.name} interprets input with a model; pass a model adapter`);
    const b = d.contract.source.spec.reliability?.model?.breaker;
    // Only dependency failures trip the breaker: timeouts and adapter errors, never refusals or overload.
    this.breaker = d.modelBreaker ?? (b ? new CircuitBreaker(b, d.env.clock, (e) => !(e instanceof Overloaded) && !(e instanceof DeadlineExceeded)) : null);
    this.inputValidator = new Ajv({ allErrors: false, strict: false }).compile(d.contract.inputSchema);
    this.tools = new Map(d.tools.map((t) => [t.name, t]));
    for (const f of d.contract.source.spec.facts)
      if (f.tool !== "request" && !this.tools.has(f.tool)) throw new Error(`contract needs read tool "${f.tool}", not registered`);
  }

  get contract() {
    return this.d.contract;
  }

  /**
   * Which decision path this request takes. Decided by the runtime from the contract and the
   * ESTABLISHED request field, never from anything a model says.
   */
  private route(evidence: Evidence): "field" | "model" {
    const src = this.d.contract.source.spec.decision.source;
    if (!src || src.mode === "model") return "model";
    if (src.mode === "fixed" || src.mode === "fact") return "field";
    const v = src.field ? evidence.established(src.field)?.value : undefined;
    const values = src.values ?? Object.fromEntries(Object.keys(this.d.contract.categories).map((k) => [k, k]));
    if (typeof v === "string" && values[v] !== undefined) return "field";
    return src.mode === "field" ? "field" : "model"; // field mode with no value: the gate refuses it
  }

  /** The structured proposal: built from the contract alone; the gate re-checks every part of it. */
  private fieldProposal(evidence: Evidence): Record<string, unknown> {
    const c = this.d.contract;
    const src = c.source.spec.decision.source!;
    const v = src.field ? evidence.established(src.field)?.value : src.category;
    const values = src.values ?? Object.fromEntries(Object.keys(c.categories).map((k) => [k, k]));
    const category = src.mode === "fixed" ? src.category : typeof v === "string" ? values[v] : undefined;
    const catSpec = category ? c.categories[category] : undefined;
    const tool = catSpec?.effect ?? Object.keys(c.effects)[0]!;
    const eff = c.effects[tool]!;
    const args: Record<string, unknown> = {};
    for (const [name, a] of Object.entries(eff.args)) {
      if (a.authority === "established") args[name] = { ref: a.from![0] };
      else if (a.fromRequest && evidence.established(a.fromRequest)) args[name] = { ref: a.fromRequest };
      else args[name] = { ref: a.default };
    }
    return {
      operation: c.name,
      contractVersion: c.version,
      decision: "PROPOSE_EFFECT",
      category: category ?? "",
      effects: [{ tool, args }],
      // Satisfies the proposal shape when an intent policy exists; the gate skips intent checks on this path.
      ...(c.source.spec.decision.evidence ? { intent: { level: "explicit", evidence: String(v ?? "") } } : {}),
    };
  }

  /** Choices offered for a clarification: one per non-abstain category, plus "something else". */
  private clarifyChoices(): { id: string; text: string }[] {
    const dec = this.d.contract.source.spec.decision;
    return [
      ...Object.entries(dec.categories)
        .filter(([name, cat]) => name !== dec.abstain && !cat.alwaysReview)
        .map(([name, cat]) => ({ id: name, text: cat.clarifyAs ?? cat.description })),
      { id: "SOMETHING_ELSE", text: "None of these" },
    ];
  }

  /**
   * Turn an intent REVIEW into a CLARIFY when the contract allows it: persist the pending
   * operation (bound to tenant, principal, operation, contract hash, idempotency key) and
   * hand the caller a single-use token. Nothing is executed.
   */
  private clarify(code: string, body: Record<string, unknown>, principal: Principal, key: string, requestHash: string, round: number, shadow: boolean): Clarification | null {
    const { env, contract, executor } = this.d;
    const cl = contract.source.spec.clarify;
    if (!cl || shadow || !executor.createPending || !(cl.on as string[]).includes(code) || round >= cl.maxRounds) return null;
    const token = env.random.id("clr");
    const now = env.clock.now();
    const expiresAt = now + cl.ttlSeconds * 1000;
    executor.createPending({
      tokenHash: sha256(token),
      tenant: principal.tenant,
      principal: principal.subject,
      operation: contract.name,
      contractHash: contract.hash,
      idempotencyKey: key,
      request: body,
      requestHash,
      round: round + 1,
      createdAt: now,
      expiresAt,
    });
    return { token, question: cl.question, choices: this.clarifyChoices(), allowText: cl.allowText, expiresAt, round: round + 1 };
  }

  /**
   * Resume a clarified operation. The answer becomes the caller's own words in the contract's
   * clarify.field, and the WHOLE pipeline runs again: fresh facts, a new proposal, the full
   * intent policy, the gate, and a version-checked commit under the original idempotency key.
   * A clarification therefore cannot authorize anything the caller could not have stated upfront.
   */
  async resume(req: ResumeRequest): Promise<OperationResult> {
    const { env, contract, executor } = this.d;
    const cl = contract.source.spec.clarify;
    const refuse = (code: RefusalCode, detail: string): OperationResult => ({ traceId: "", operationId: "", outcome: "REFUSE", code, detail, httpStatus: HTTP[code] ?? 422 });
    const p = checkPrincipal(contract, req.principal, env.clock.now());
    if (p) return refuse(p.code, p.detail);
    if (!cl || !executor.claimPending) return refuse("CLARIFICATION_INVALID", "this operation does not support clarification");
    const a = req.answer ?? {};
    const choices = this.clarifyChoices();
    const choice = a.choice === undefined ? undefined : choices.find((c) => c.id === a.choice);
    if (a.choice !== undefined && !choice) return refuse("SCHEMA_INVALID", "unknown choice");
    if (a.text !== undefined && (!cl.allowText || typeof a.text !== "string" || a.text.length > 500)) return refuse("SCHEMA_INVALID", "free-text answer not allowed or too long");
    if (!choice && !a.text) return refuse("SCHEMA_INVALID", "an answer is required");
    if (typeof req.token !== "string" || req.token.length > 200) return refuse("CLARIFICATION_INVALID", "invalid clarification");
    const principal = req.principal!;
    const pending = executor.claimPending(sha256(req.token), { tenant: principal.tenant, principal: principal.subject, operation: contract.name, contractHash: contract.hash, now: env.clock.now() });
    if (!pending) return refuse("CLARIFICATION_INVALID", "invalid clarification");
    const field = cl.field.slice("request.".length);
    const prior = typeof pending.request[field] === "string" ? `${pending.request[field]}\n` : "";
    const said = [choice ? choice.text : null, a.text ?? null].filter(Boolean).join(". ");
    const body = { ...pending.request, [field]: `${prior}${said}` };
    return this.handle({ principal, body, idempotencyKey: pending.idempotencyKey }, { resume: { round: pending.round, requestHash: pending.requestHash } });
  }

  /** Time a stage when a profiler is attached; otherwise just run it. */
  private timed<T>(stage: string, fn: () => T): T {
    const prof = this.d.env.profile;
    if (!prof) return fn();
    const t = performance.now();
    const r = fn();
    if (r instanceof Promise) return r.finally(() => prof.span(stage, performance.now() - t)) as T;
    prof.span(stage, performance.now() - t);
    return r;
  }

  /**
   * Run one operation. With `shadow: true` the decision pipeline is identical but
   * the commit is a dry run (rolled back): no state change, no outbox, no effect.
   */
  async handle(req: OperationRequest, opts: { shadow?: boolean; resume?: { round: number; requestHash: string } } = {}): Promise<OperationResult> {
    const { env, contract } = this.d;
    const shadow = opts.shadow === true;
    const round = opts.resume?.round ?? 0;
    const started = env.clock.now();
    const operationId = env.random.id("op");
    const traceId = operationId.replace(/^op_/, "tr_");
    const trace: TraceRecord = {
      traceId,
      runtimeVersion: RUNTIME_VERSION,
      contractHash: contract.hash,
      seed: this.d.seed ?? null,
      clockStart: started,
      principal: req.principal,
      request: { body: req.body, idempotencyKey: req.idempotencyKey },
      toolResults: [],
      model: [],
      lookups: [],
      commits: [],
      outcome: null,
    };
    // Key decisions are recorded only on the durable-claim path, so older traces replay unchanged.
    const claims: (KeyState | { kind: "owner"; owns: boolean })[] = [];
    const audit: AuditRecord = {
      traceId,
      operationId,
      mode: shadow ? "shadow" : "authoritative",
      at: started,
      operation: contract.name,
      contractVersion: contract.version,
      contractHash: contract.hash,
      modelId: null,
      principal: req.principal ? hashPrincipal(req.principal.subject) : "anonymous",
      tenant: req.principal?.tenant ?? "",
      input: redactInput(req.body),
      proposal: null,
      gate: { outcome: "REFUSE", checks: [] },
      evidence: [],
      effects: [],
      attempts: 0,
      latency: { totalMs: 0, modelMs: 0 },
      tokens: { prompt: 0, completion: 0 },
    };

    // Idempotency policy: the contract's declaration wins; otherwise the runtime's configuration.
    const declared = contract.source.spec.idempotency;
    const settleMode = declared?.settle ?? this.d.idempotency?.settle ?? "release";
    let held = false; // this attempt owns the key's durable claim
    let key: string | undefined;
    const finish = (r: Omit<OperationResult, "traceId" | "operationId" | "httpStatus">, gate?: GateDecision): OperationResult => {
      const httpStatus =
        r.outcome === "ALLOW" ? (r.effect?.status === "duplicate" ? 200 : 201) : r.outcome === "REVIEW" || r.outcome === "CLARIFY" ? 202 : HTTP[r.code!] ?? 422;
      const result: OperationResult = { traceId, operationId, httpStatus, ...r };
      audit.gate = { outcome: r.outcome, code: r.code, detail: r.detail, checks: gate?.checks ?? audit.gate.checks };
      audit.latency.totalMs = env.clock.now() - started;
      // The clarification token never enters the trace (it is a bearer secret); its round does.
      trace.outcome = { outcome: r.outcome, code: r.code ?? null, detail: r.detail ?? null, effect: r.effect ?? null, ...(r.clarification ? { clarifyRound: r.clarification.round } : {}), ...(round ? { resumedRound: round } : {}) };
      if (held) {
        held = false;
        const settled: SettledOutcome = { outcome: r.outcome, ...(r.code ? { code: r.code } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
        // A committed effect already replaced the claim; anything else frees the key and tells waiters.
        try {
          const terminal = settleMode === "terminal" && isTerminal(r);
          this.d.executor.releaseKey!(key!, operationId, settled, terminal);
        } catch {
          /* the lease expires on its own; releasing early is an optimisation */
        }
      }
      if (claims.length) trace.claims = claims;
      const committed = r.effect?.status === "committed";
      // Crash window for tests: the effect is committed, nothing after it is persisted yet.
      if (committed) env.faults.check("engine.afterCommit");
      // Records are written AFTER the outcome is decided (and committed). A failure here must
      // never turn a committed effect into a reported failure: it is surfaced separately.
      const failed: ("audit" | "trace" | "status")[] = [];
      const persist = (stage: "audit" | "trace" | "status", write: () => void) => {
        try {
          write();
        } catch (error) {
          failed.push(stage);
          try {
            this.d.onObservabilityFailure?.({ stage, error, traceId, operationId, operation: contract.name, committed });
          } catch {
            /* a failing hook must not change the outcome either */
          }
        }
      };
      this.timed("audit+trace.write", () => {
        persist("audit", () => this.d.audit.write(audit));
        persist("trace", () => this.d.traces.put(trace));
      });
      if (!shadow) persist("status", () => this.timed("db.operationStatus", () => this.d.executor.recordOperation(operationId, contract.name, r.code ? `${r.outcome}:${r.code}` : r.outcome, r.detail)));
      if (failed.length) result.observability = { failed };
      return result;
    };

    // 1. Identity before anything else, and before any inference.
    const p = this.timed("principal", () => checkPrincipal(contract, req.principal, env.clock.now()));
    if (p) return finish({ outcome: "REFUSE", code: p.code, detail: p.detail });
    const principal = req.principal!;

    // Rate limits come right after identity, before any inference is spent.
    if (this.d.limiter) {
      const rl = this.d.limiter.check({ tenant: principal.tenant, principal: principal.subject, operation: contract.name, apiKey: principal.keyId });
      if (!rl.ok) return finish({ outcome: "REFUSE", code: "RATE_LIMITED", detail: `rate limit (${rl.rule})`, retryAfterMs: rl.retryAfterMs });
    }
    const rel = contract.source.spec.reliability;
    const deadline = rel?.deadlineMs ? new Deadline(env.clock, rel.deadlineMs) : null;

    // 2. Input shape.
    if (!this.timed("input.validate", () => this.inputValidator(req.body))) {
      const e = this.inputValidator.errors?.[0];
      return finish({ outcome: "REFUSE", code: "SCHEMA_INVALID", detail: `input ${e?.instancePath || "/"} ${e?.message}` });
    }
    const body = req.body as Record<string, unknown>;
    if (!req.idempotencyKey || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(req.idempotencyKey))
      return finish({ outcome: "REFUSE", code: "SCHEMA_INVALID", detail: "Idempotency-Key header (8-128 safe chars) is required" });
    // On resume the operation keeps the ORIGINAL request's identity: same idempotency key, same hash.
    const requestHash = opts.resume?.requestHash ?? sha256(canonical(body));
    key = scopedKey(principal.tenant, principal.subject, contract.name, req.idempotencyKey);
    // Claims guard effects: an operation with no idempotent effect takes none (no claim overhead).
    const needsClaim = Object.values(contract.source.spec.effects ?? {}).some((e) => e.idempotency === "required");
    const durable = !shadow && needsClaim && typeof this.d.executor.claimKey === "function";

    // 3. Intent is persisted before any effect.
    if (!shadow) this.timed("db.operationStatus", () => this.d.executor.recordOperation(operationId, contract.name, "received"));

    const duplicate = (prior: { effectId: string; result: Record<string, unknown> }) => {
      audit.effects = [{ effectId: prior.effectId, tool: "(prior)", status: "duplicate", provenance: {} }];
      return finish({ outcome: "ALLOW", effect: { effectId: prior.effectId, status: "duplicate", result: prior.result } });
    };
    const replayDetected = () => finish({ outcome: "REFUSE", code: "REPLAY_DETECTED", detail: "idempotency key reused for a different request" });

    const idem: IdemOpts = { ...IDEMPOTENCY_DEFAULTS, ...(this.d.idempotency ?? {}), settle: settleMode, ...(declared?.retentionMs ? { retentionMs: declared.retentionMs } : {}) };
    // A duplicate never waits past its own wait budget, nor past the request deadline.
    const waitUntil = Math.min(env.clock.now() + idem.waitMs, deadline ? deadline.at : Infinity);
    type Wait = { wait: string };
    const RETAKE = Symbol("retake");

    /** 3a. One claim attempt (inside the queue slot, if any): own the key, or learn who does. */
    const claimOnce = (): OperationResult | Wait | null => {
      const c = this.timed("db.idempotencyClaim", () => this.d.executor.claimKey!(key!, requestHash, operationId, idem.leaseMs, idem.retentionMs));
      claims.push(c);
      if (c.kind === "claimed") return ((held = true), null);
      if (c.kind === "committed") return duplicate(c.prior);
      if (c.kind === "conflict") return replayDetected();
      if (c.kind === "settled") return finish({ ...(c.outcome as Omit<OperationResult, "traceId" | "operationId" | "httpStatus">), answeredBy: c.owner });
      if (c.kind !== "inflight") throw new Error(`unexpected key state ${c.kind}`);
      return { wait: c.owner };
    };

    /** Wait OUTSIDE the queue for the owner's answer. A final result, or null to claim again. */
    const waitFor = async (owner: string): Promise<OperationResult | null> => {
      const inProgress = (detail: string) => finish({ outcome: "REFUSE", code: "IDEMPOTENCY_IN_PROGRESS", detail, retryAfterMs: idem.maxPollMs * 2 });
      if (deadline?.expired()) return finish({ outcome: "REFUSE", code: "DEADLINE_EXCEEDED", detail: "deadline exceeded while waiting for a duplicate request" });
      if (env.clock.now() >= waitUntil) return inProgress("a request with this idempotency key is still in progress");
      const s = await this.awaitKey(key!, requestHash, owner, waitUntil, idem);
      if (s === "busy") return inProgress("too many requests are waiting on in-flight duplicates");
      if (s === "timeout")
        return deadline && deadline.at <= env.clock.now()
          ? finish({ outcome: "REFUSE", code: "DEADLINE_EXCEEDED", detail: "deadline exceeded while waiting for a duplicate request" })
          : inProgress("a request with this idempotency key is still in progress");
      claims.push(s);
      if (s.kind === "committed") return duplicate(s.prior);
      if (s.kind === "conflict") return replayDetected();
      if (s.kind === "settled" && s.owner === owner) return finish({ ...(s.outcome as Omit<OperationResult, "traceId" | "operationId" | "httpStatus">), answeredBy: owner });
      return null; // free, settled by someone else, re-owned, or the owner's lease expired: claim again
    };

    const evaluate = async (): Promise<OperationResult | typeof RETAKE> => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        audit.attempts = attempt;
        if (!durable) {
          // 3a (no durable claims: replay of older traces, custom committers). A retry of a committed request returns the original result.
          const prior = this.timed("db.idempotencyLookup", () => this.d.executor.lookup(key!));
          trace.lookups.push(prior ?? null);
          if (prior) return prior.requestHash !== requestHash ? replayDetected() : duplicate(prior);
        }

        // 4. Facts, each minted on the channel it came from.
        await env.scheduler.yield("facts");
        const evidence = new Evidence(contract, principal, `${operationId}.${attempt}`, () => new Date(env.clock.now()));
        try {
          await this.timed("facts (tools + PSAP mint)", () => this.gather(evidence, body, principal, trace, attempt, deadline));
        } catch (e) {
          const t = transportRefusal(e, "EXECUTION_FAILED", "read failed");
          return finish({ outcome: "REFUSE", code: t.refuse, detail: t.detail, retryAfterMs: t.retryAfterMs });
        }
        audit.evidence = evidence.trace();

        // 5. Decide: a structured category from the caller's field (no model), or the model.
        const route = this.route(evidence);
        audit.decisionSource = route;
        let proposal: unknown;
        if (route === "field") {
          proposal = this.fieldProposal(evidence);
          audit.proposal = summarize(proposal, JSON.stringify(proposal));
        } else if (!this.d.model) {
          return finish({ outcome: "REFUSE", code: "MODEL_UNAVAILABLE", detail: "this request needs interpretation and no model is configured; send a structured value" });
        } else {
          await env.scheduler.yield("model");
          const input = this.timed("model.inputBuild", () => this.modelInput(evidence));
          const m = await this.timed("model.propose (adapter + parse)", () => this.propose(input, trace, audit, principal.tenant, deadline));
          if ("refuse" in m) return finish({ outcome: "REFUSE", code: m.refuse, detail: m.detail, retryAfterMs: m.retryAfterMs });
          audit.proposal = summarize(m.proposal, m.text);
          const confirmFail = await this.timed("model.confirm", () => this.confirmIntent(m.proposal, evidence, trace, audit, principal.tenant, deadline));
          if (confirmFail) return finish({ outcome: "REFUSE", code: confirmFail.refuse, detail: confirmFail.detail, retryAfterMs: confirmFail.retryAfterMs });
          proposal = m.proposal;
        }

        // 6. The gate decides.
        await env.scheduler.yield("gate");
        const decision = this.timed("gate (schema + PSAP + exprs)", () => evaluateProposal(contract, principal, evidence, proposal, env.clock.now(), { source: route }));
        audit.evidence = evidence.trace();
        // An attempt that lost its claim (lease expired, taken over) decided on state another
        // attempt may have changed: its answer must not differ from the owner's, so converge.
        if (decision.outcome !== "ALLOW" && held) {
          const owns = this.timed("db.idempotencyOwner", () => this.d.executor.ownsKey!(key!, operationId));
          claims.push({ kind: "owner", owns });
          if (!owns) {
            held = false;
            return RETAKE; // leave the queue slot, then converge on (or take) the key again
          }
        }
        if (decision.outcome === "REVIEW") {
          const cl = this.clarify(decision.code, body, principal, req.idempotencyKey!, requestHash, round, shadow);
          if (cl) return finish({ outcome: "CLARIFY", code: decision.code, detail: decision.detail, clarification: cl, ...(decision.reason ? { reason: decision.reason } : {}) }, decision);
        }
        if (decision.outcome !== "ALLOW") return finish({ outcome: decision.outcome, code: decision.code, detail: decision.detail, ...(decision.reason ? { reason: decision.reason } : {}) }, decision);

        // 7. Commit (domain write + effect record + outbox) atomically.
        await env.scheduler.yield("commit");
        const eff = decision.effects[0]!;
        let c: CommitResult;
        try {
          env.faults.check("engine.beforeCommit");
          if (shadow) {
            if (!this.d.executor.dryRun) throw new Error("shadow mode needs an executor with dryRun");
            c = this.d.executor.dryRun(eff);
          } else c = this.timed("db.commit (txn + outbox)", () => this.d.executor.commit(eff, { idempotencyKey: req.idempotencyKey!, requestHash, operationId, ...(durable && idem.settle === "terminal" ? { fenceOwner: operationId } : {}) }));
          trace.commits.push({ attempt, effect: eff, result: c });
        } catch (e) {
          const detail = e instanceof InjectedFault || e instanceof ReplayedFailure ? e.message : `commit failed: ${(e as Error).message}`;
          trace.commits.push({ attempt, effect: eff, error: detail });
          return finish({ outcome: "REFUSE", code: "EXECUTION_FAILED", detail }, decision);
        }
        if (c.status === "refused") {
          if (c.code === "STALE_STATE" && attempt < 2) continue; // re-decide on fresh state
          if (c.code === "IDEMPOTENCY_IN_PROGRESS" && durable) {
            held = false; // fenced (settled-outcome mode): converge on the key's current answer
            return RETAKE;
          }
          return finish({ outcome: "REFUSE", code: c.code, detail: c.detail, ...(c.reason ? { reason: c.reason } : {}) }, decision);
        }
        audit.effects = [{ effectId: c.effectId, tool: eff.tool, status: c.status, provenance: eff.provenance }];
        return finish({ outcome: "ALLOW", effect: { effectId: c.effectId, status: c.status, result: c.result } }, decision);
      }
      return finish({ outcome: "REFUSE", code: "STALE_STATE", detail: "state changed during re-evaluation" });
    };

    const resource = String(body[contract.source.spec.concurrency.key.replace(/^request\./, "")]);
    const qkey = `${principal.tenant}\u0000${resource}`;
    /** The per-resource queue slot is held for claim + evaluation only, never while waiting. */
    const inSlot = (fn: () => Promise<OperationResult | Wait | typeof RETAKE>): Promise<OperationResult | Wait | typeof RETAKE> => {
      if (this.d.serialize === false) return fn();
      if (this.queue.size(qkey) >= contract.source.spec.concurrency.maxQueue)
        return Promise.resolve(finish({ outcome: "REFUSE", code: "OVERLOADED", detail: "too many operations queued for this resource", retryAfterMs: 1000 }));
      return this.queue.run(qkey, fn);
    };
    const run = async (): Promise<OperationResult> => {
      for (let round = 0; round < 8; round++) {
        const r = await inSlot(async () => {
          if (durable) {
            const c = claimOnce();
            if (c !== null) return c;
          }
          return evaluate();
        });
        if (r === RETAKE) continue;
        if ("wait" in r) {
          const w = await waitFor(r.wait);
          if (w) return w;
          continue;
        }
        return r;
      }
      return finish({ outcome: "REFUSE", code: "IDEMPOTENCY_IN_PROGRESS", detail: "the idempotency key kept changing hands", retryAfterMs: idem.maxPollMs * 2 });
    };

    const guarded = async (): Promise<OperationResult> => {
      try {
        return await run();
      } catch (e) {
        if (held) {
          held = false;
          try {
            this.d.executor.releaseKey!(key!, operationId, { outcome: "REFUSE", code: "EXECUTION_FAILED", detail: "operation failed" });
          } catch {
            /* the lease expires on its own */
          }
        }
        throw e;
      }
    };
    return guarded();
  }

  private async gather(ev: Evidence, body: Record<string, unknown>, principal: Principal, trace: TraceRecord, attempt: number, deadline: Deadline | null) {
    const { env, contract } = this.d;
    for (const f of contract.source.spec.facts) {
      if (f.tool === "request") {
        // Convention: request.<field> <- body.<field>; claims <- body.claims.<last segment>.
        for (const p of f.provides) {
          const v = body[p.slice("request.".length)];
          if (v !== undefined) ev.record({ kind: "principal" }, p, v);
        }
        const claims = (body.claims ?? {}) as Record<string, unknown>;
        for (const p of f.claims ?? []) {
          const v = claims[p.split(".").pop()!];
          if (v !== undefined) ev.record({ kind: "principal" }, p, v);
        }
        continue;
      }
      const args: Record<string, unknown> = {};
      let ready = true;
      for (const [a, pred] of Object.entries(f.args ?? {})) {
        // Tool arguments may come from the authenticated caller ("load MY account").
        if (pred === "principal.subject" || pred === "principal.tenant") {
          args[a] = pred === "principal.subject" ? principal.subject : principal.tenant;
          continue;
        }
        const e = ev.established(pred);
        if (!e) ready = false;
        else args[a] = e.value;
      }
      if (!ready) continue; // an unestablished input means this tool's facts stay unestablished
      const toolRel = contract.source.spec.reliability?.tools;
      const timeoutMs = toolRel?.timeoutMs ?? Infinity;
      const result = await retry(
        async () => {
          try {
            env.faults.check(`tool.${f.tool}`);
            const read = this.tools.get(f.tool)!.read(args, { tenant: principal.tenant });
            const r = deadline ? await deadline.race(read, timeoutMs) : Number.isFinite(timeoutMs) ? await raceTimeout(env.clock, read, timeoutMs) : await read;
            if (r === TIMED_OUT) throw deadline?.expired() ? new DeadlineExceeded() : new RetryableError(`tool ${f.tool} timed out`, true, "TOOL_TIMEOUT");
            return r;
          } catch (e) {
            // Failed attempts are part of the trace, so replay reproduces the retries exactly.
            trace.toolResults.push({ attempt, tool: f.tool, args, result: null, ...failureFields(e) } as never);
            throw e;
          }
        },
        toolRel?.retry ?? NO_RETRY,
        env,
        { deadline: deadline ?? undefined },
      );
      trace.toolResults.push({ attempt, tool: f.tool, args, result });
      if (!result) continue;
      for (const p of f.provides) if (result[p] !== undefined && result[p] !== null) ev.record({ kind: "tool", tool: f.tool }, p, result[p]);
      for (const p of f.claims ?? []) if (result[p] !== undefined && result[p] !== null) ev.record({ kind: "tool", tool: f.tool }, p, result[p]);
    }
  }

  private modelInput(ev: Evidence): ModelInput {
    const c = this.d.contract;
    const observations: Record<string, unknown> = {};
    for (const p of c.source.spec.model!.sees) {
      const op = ev.operative(p);
      if (op) observations[p] = op.value;
    }
    return {
      operation: c.name,
      contractVersion: c.version,
      role: c.source.spec.model!.role,
      categories: Object.entries(c.categories).map(([name, cat]) => ({ name, description: cat.description })),
      observations,
      effects: Object.entries(c.effects).map(([tool, e]) => ({
        tool,
        args: Object.entries(e.args).map(([name, a]) => ({ name, type: a.type, authority: a.authority, from: a.from, default: a.default })),
      })),
      referenceable: [...c.predicates].sort(),
      proposalSchema: c.proposalSchema,
      ...(c.source.spec.decision.evidence ? { intent: { evidenceFrom: [c.source.spec.decision.evidence.from].flat().join(" or ") } } : {}),
    };
  }

  /**
   * Intent policy, runtime half. The `confirmed` flag is the runtime's, never the model's:
   * any model-supplied value is removed first. The confirmation question (declared per
   * category in the contract) is asked separately, about the evidence source only.
   * Only a "yes" sets confirmed; anything else leaves the gate to route to REVIEW.
   */
  private async confirmIntent(
    proposal: unknown,
    evidence: Evidence,
    trace: TraceRecord,
    audit: AuditRecord,
    tenant: string,
    deadline: Deadline | null,
  ): Promise<Refusal | null> {
    const { env, contract } = this.d;
    const model = this.d.model!; // model path only: route() chose "model", and the constructor guarantees one
    const policy = contract.source.spec.decision.evidence;
    const p = proposal as { decision?: unknown; category?: unknown; intent?: { confirmed?: unknown } };
    if (!policy || !p || typeof p !== "object" || !p.intent || typeof p.intent !== "object") return null;
    delete p.intent.confirmed;
    if (p.decision !== "PROPOSE_EFFECT" || typeof p.category !== "string") return null;
    const confirm = contract.categories[p.category]?.intent?.confirm;
    if (!confirm || !model.ask) return null;
    const questions = typeof confirm === "string" ? [{ ask: confirm, expect: "yes" as const }] : confirm;
    // The confirmation reads ALL of the caller's own texts (e.g. message + clarification).
    // Single-source contracts get exactly the message, as before.
    const texts = [policy.from].flat().map((f) => evidence.established(f)?.value).filter((v): v is string => typeof v === "string");
    if (!texts.length) return null;
    const text = texts.join("\n\n");
    const t0 = env.clock.now();
    try {
      for (const q of questions) {
        const hash = hashModelInput({ question: q.ask, text });
        const out = await this.infer(hash, tenant, deadline, trace, "model.confirm", (signal) => model.ask!({ question: q.ask, text }, { maxOutputTokens: 8, signal }));
        trace.model.push({ inputHash: hash, modelId: out.modelId, output: out });
        audit.tokens.prompt += out.promptTokens;
        audit.tokens.completion += out.completionTokens;
        if (out.answer !== q.expect) return null; // stop at the first mismatch: not confirmed
      }
      p.intent.confirmed = true;
      return null;
    } catch (e) {
      return transportRefusal(e, "MODEL_ERROR", "confirmation");
    } finally {
      audit.latency.modelMs += env.clock.now() - t0;
    }
  }

  /**
   * One model call through the reliability stack:
   *   fair scheduler (concurrency, per-tenant queues) -> circuit breaker -> retry (transport
   *   failures only) -> per-attempt timeout, all bounded by the request deadline. Every failed
   *   attempt is recorded in the trace so replay reproduces it.
   */
  private async infer<T extends { modelId: string }>(
    hash: string,
    tenant: string,
    deadline: Deadline | null,
    trace: TraceRecord,
    faultPoint: string,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { env, contract } = this.d;
    const model = this.d.model!; // model path only: route() chose "model", and the constructor guarantees one
    const budget = contract.source.spec.model!.budget;
    const attempt = async (): Promise<T> => {
      const ctrl = new AbortController();
      const onDeadline = () => ctrl.abort();
      deadline?.signal.addEventListener("abort", onDeadline, { once: true });
      try {
        env.faults.check(faultPoint);
        const p = call(ctrl.signal);
        const r = deadline ? await deadline.race(p, budget.timeoutMs) : await raceTimeout(env.clock, p, budget.timeoutMs);
        if (r === TIMED_OUT) {
          ctrl.abort(); // cancel the inference still running
          throw deadline?.expired() ? new DeadlineExceeded() : new RetryableError(`no model output within ${budget.timeoutMs}ms`, true, "MODEL_TIMEOUT");
        }
        return r;
      } catch (e) {
        trace.model.push(failureRecord(hash, (e as { modelId?: string }).modelId ?? model.id, e) as never);
        throw e;
      } finally {
        deadline?.signal.removeEventListener("abort", onDeadline);
      }
    };
    const withRetry = () => retry(attempt, contract.source.spec.reliability?.model?.retry ?? NO_RETRY, env, { deadline: deadline ?? undefined });
    const withBreaker = () => (this.breaker ? this.breaker.run(withRetry) : withRetry());
    return this.d.scheduler ? this.d.scheduler.run(tenant, withBreaker, deadline ?? undefined) : withBreaker();
  }

  private async propose(
    input: ModelInput,
    trace: TraceRecord,
    audit: AuditRecord,
    tenant: string,
    deadline: Deadline | null,
  ): Promise<{ proposal: unknown; text: string } | Refusal> {
    const { env, contract } = this.d;
    const model = this.d.model!; // model path only: route() chose "model", and the constructor guarantees one
    const budget = contract.source.spec.model!.budget;
    audit.modelId = model!.id;
    let lastErr = "";
    const hash = hashModelInput(input);
    for (let i = 0; i <= budget.maxRetries; i++) {
      const t0 = env.clock.now();
      let out;
      try {
        out = await this.infer(hash, tenant, deadline, trace, "model.propose", (signal) => model.propose(input, { maxOutputTokens: budget.maxOutputTokens, signal }));
      } catch (e) {
        return transportRefusal(e, "MODEL_ERROR", "model");
      } finally {
        audit.latency.modelMs += env.clock.now() - t0;
      }
      trace.model.push({ inputHash: hash, modelId: out.modelId, output: out });
      audit.tokens.prompt += out.promptTokens;
      audit.tokens.completion += out.completionTokens;
      if (out.completionTokens > budget.maxOutputTokens)
        return { refuse: "BUDGET_EXCEEDED", detail: `model output ${out.completionTokens} tokens > ${budget.maxOutputTokens}` };
      try {
        return { proposal: JSON.parse(out.text), text: out.text };
      } catch {
        lastErr = "model output is not JSON";
      }
    }
    return { refuse: "SCHEMA_INVALID", detail: lastErr };
  }
}


/**
 * A failed attempt as recorded in the trace. Absent fields are OMITTED, never `undefined`:
 * traces round-trip through JSON on disk, and canonicalJson treats `undefined` keys as
 * out of domain (docs/canonical-json.md).
 */
function failureFields(e: unknown): { error: string; retryable: boolean; code?: string } {
  const code = (e as { code?: unknown })?.code;
  return { error: String((e as Error)?.message ?? e), retryable: isRetryable(e), ...(typeof code === "string" ? { code } : {}) };
}
function failureRecord(inputHash: string, modelId: string, e: unknown) {
  return { inputHash, modelId, ...failureFields(e) };
}

function raceTimeout<T>(clock: { sleep(ms: number): Promise<void> }, p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, clock.sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)]);
}

function redactInput(body: unknown): AuditRecord["input"] {
  if (!body || typeof body !== "object") return { fields: [] };
  const b = body as Record<string, unknown>;
  const msg = typeof b.message === "string" ? b.message : undefined;
  return { fields: Object.keys(b).sort(), ...(msg ? { messageSha256: sha256(msg), messageLength: msg.length } : {}) };
}

function summarize(p: unknown, text: string): AuditRecord["proposal"] {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const effects = Array.isArray(o.effects) ? o.effects : [];
  return {
    decision: typeof o.decision === "string" ? o.decision : undefined,
    category: typeof o.category === "string" ? o.category : undefined,
    effectTools: effects.map((e) => String((e as { tool?: unknown })?.tool)),
    sha256: sha256(text),
  };
}
