/**
 * @modelnativ/core: the embedded host interface.
 *
 * Embedded mode is NOT a second architecture: `execute()` and `bind()` call the
 * same Engine (same contract compiler, PSAP gate, executor, audit, replay) that
 * standalone `serve` uses. What this adds is the adoption path: replace one
 * business-logic function behind an existing controller, run it in shadow
 * first, switch modes per operation, and roll back by flipping a mode.
 *
 * Identity is delegated explicitly: every call carries the host's authenticated
 * principal, mapped by the host. There is no ambient identity and no way for the
 * model to obtain one.
 */
import type { Principal, RefusalCode } from "@modelnativ/contract-schema";
import { TRANSIENT_CODES, type Engine, type OperationResult } from "@modelnativ/runtime";
import { sha256 } from "@modelnativ/observability";

export type Mode = "legacy" | "shadow" | "modelnativ" | "fallback";

/**
 * What an OperationResult means for a host:
 *   committed         ALLOW: the effect is committed (or was, for a duplicate)
 *   business_refusal  REFUSE decided by the contract/gate/adapter (has `reason` when declared)
 *   review / clarify  needs a person / needs the caller's answer
 *   retryable         REFUSE for an infrastructure reason; nothing was committed by this request
 * A refusal that carries a contract- or adapter-declared `reason` (e.g. STALE_STATE with reason
 * "version_conflict") is the application's answer, so it is a business_refusal.
 */
export type ResultKind = "committed" | "business_refusal" | "review" | "clarify" | "retryable";
export function classify(r: OperationResult): ResultKind {
  if (r.outcome === "ALLOW") return "committed";
  if (r.outcome === "REVIEW") return "review";
  if (r.outcome === "CLARIFY") return "clarify";
  if (r.reason) return "business_refusal";
  return TRANSIENT_CODES.has(r.code ?? "") ? "retryable" : "business_refusal";
}

/** An infrastructure outcome (nothing committed by this call): retry later, with the same key. */
export class ModelnativRetryableError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;
  constructor(readonly result: OperationResult) {
    // The detail (e.g. the database error of a failed commit) helps the host debug; it is in-process
    // only: the standalone HTTP server never returns 5xx detail.
    super(`modelnativ: ${result.code} (retryable)${result.detail ? `: ${result.detail}` : ""}`);
    this.code = result.code ?? "UNKNOWN";
    if (result.retryAfterMs !== undefined) this.retryAfterMs = result.retryAfterMs;
  }
}
/** The kernel threw (a bug or a crashed dependency). An effect MAY have been committed: never fall back. */
export class ModelnativUnexpectedError extends Error {
  constructor(readonly cause: unknown) {
    super(`modelnativ: unexpected failure: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export type CallContext = { principal: Principal | null; idempotencyKey: string };

/** Contract-aware normal form both paths are compared in. */
export type Normalized = { outcome: "ALLOW" | "REFUSE" | "REVIEW"; amount?: number | null; [k: string]: unknown };

export type ShadowRecord = {
  operation: string;
  traceId: string;
  /** sha256 of the canonical input: correlates runs without storing the input. */
  inputSha256: string;
  legacy: Normalized;
  modelnativ: Normalized;
  modelnativCode: string | null;
  match: boolean;
};

export interface ShadowSink {
  write(r: ShadowRecord): void;
}
export class MemoryShadowSink implements ShadowSink {
  readonly records: ShadowRecord[] = [];
  write(r: ShadowRecord) {
    this.records.push(r);
  }
}

export type ShadowReport = {
  operation: string;
  total: number;
  matches: number;
  mismatches: ShadowRecord[];
  byPair: Record<string, number>;
};

/** Failures that may fall back to legacy: the kernel could not decide, and nothing was committed. */
const FALLBACK_ELIGIBLE: RefusalCode[] = ["MODEL_TIMEOUT", "MODEL_ERROR", "MODEL_UNAVAILABLE", "BUDGET_EXCEEDED", "OVERLOADED", "EXECUTION_FAILED"];

export type Binding<A extends unknown[], R> = {
  /** Host identity -> delegated principal. Returning null means unauthenticated. */
  principal: (...args: A) => Principal | null;
  input: (...args: A) => unknown;
  idempotencyKey: (...args: A) => string;
  /** Kernel result -> the host function's return type, so callers are unchanged. */
  output: (r: OperationResult, ...args: A) => R;
  normalizeLegacy: (r: R) => Normalized;
  normalizeModelnativ: (r: OperationResult) => Normalized;
  /**
   * "throw" (default): retryable infrastructure outcomes throw ModelnativRetryableError instead of
   * reaching `output`, so a host never turns an outage into a business answer. "output": pass
   * every outcome to `output` (the previous behaviour; the host must use classify()).
   */
  onInfrastructure?: "throw" | "output";
};

export type BoundFunction<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
  readonly operation: string;
};

export class Modelnativ {
  private engines = new Map<string, Engine>();
  private modes = new Map<string, Mode>();
  constructor(
    engines: Engine[],
    private opts: { modes?: Record<string, Mode>; shadow?: ShadowSink; hasCommitted?: (r: OperationResult) => boolean } = {},
  ) {
    for (const e of engines) this.engines.set(e.contract.name, e);
    for (const [op, m] of Object.entries(opts.modes ?? {})) this.setMode(op, m);
  }

  private engine(op: string): Engine {
    const e = this.engines.get(op);
    if (!e) throw new Error(`no contract loaded for operation "${op}"`);
    return e;
  }

  mode(op: string): Mode {
    return this.modes.get(op) ?? "legacy";
  }

  /** Rollback is a mode change: setMode(op, "legacy"). Takes effect on the next call. */
  setMode(op: string, mode: Mode) {
    this.engine(op);
    this.modes.set(op, mode);
  }

  /** Run an operation through the kernel (authoritative). */
  execute(op: string, input: unknown, ctx: CallContext): Promise<OperationResult> {
    return this.engine(op).handle({ principal: ctx.principal, body: input, idempotencyKey: ctx.idempotencyKey });
  }

  /** Resume an operation that returned CLARIFY, with the caller's answer. Full checks re-run. */
  resume(op: string, token: string, answer: { choice?: string; text?: string }, ctx: { principal: Principal | null }): Promise<OperationResult> {
    return this.engine(op).resume({ principal: ctx.principal, token, answer });
  }

  /** Run an operation through the kernel with no effects (dry-run commit). */
  shadow(op: string, input: unknown, ctx: CallContext): Promise<OperationResult> {
    return this.engine(op).handle({ principal: ctx.principal, body: input, idempotencyKey: ctx.idempotencyKey }, { shadow: true });
  }

  /**
   * Wrap an existing business-logic function. The returned function has the same
   * signature; which implementation runs depends on the operation's mode.
   */
  bind<A extends unknown[], R>(op: string, legacy: (...args: A) => Promise<R>, b: Binding<A, R>): BoundFunction<A, R> {
    this.engine(op);
    const fn = async (...args: A): Promise<R> => {
      const mode = this.mode(op);
      if (mode === "legacy") return legacy(...args);
      const ctx = { principal: b.principal(...args), idempotencyKey: b.idempotencyKey(...args) };
      const input = b.input(...args);

      if (mode === "shadow") {
        // Phase 0: evaluate first, against the same state legacy will see, then let legacy act.
        // The shadow path cannot write: its commit is a rolled-back dry run.
        const s = await this.shadow(op, input, ctx).catch((e: Error): OperationResult => ({ traceId: "", operationId: "", outcome: "REFUSE", code: "EXECUTION_FAILED", detail: e.message, httpStatus: 503 }));
        const out = await legacy(...args);
        const l = b.normalizeLegacy(out);
        const m = b.normalizeModelnativ(s);
        this.opts.shadow?.write({
          operation: op,
          traceId: s.traceId,
          inputSha256: sha256(JSON.stringify(input)),
          legacy: l,
          modelnativ: m,
          modelnativCode: s.code ?? null,
          match: JSON.stringify(sortKeys(l)) === JSON.stringify(sortKeys(m)),
        });
        return out;
      }

      let r: OperationResult;
      try {
        r = await this.execute(op, input, ctx);
      } catch (e) {
        throw new ModelnativUnexpectedError(e); // never fall back: an effect may be committed
      }
      if (mode === "fallback" && r.outcome === "REFUSE" && FALLBACK_ELIGIBLE.includes(r.code as RefusalCode) && !this.committed(r)) {
        // Fall back only for a failure THIS call evaluated, and only if the key has no committed
        // effect. A converged copy (answeredBy) means another call owned the key and already fell
        // back: running legacy again would repeat it.
        const committed = ctx.principal ? this.engine(op).findCommitted(ctx.principal, ctx.idempotencyKey) : undefined;
        if (committed) return b.output({ ...r, outcome: "ALLOW", code: undefined, effect: { ...committed, status: "duplicate" }, httpStatus: 200 }, ...args);
        if (!r.answeredBy) return legacy(...args);
      }
      if ((b.onInfrastructure ?? "throw") === "throw" && classify(r) === "retryable") throw new ModelnativRetryableError(r);
      return b.output(r, ...args);
    };
    return Object.assign(fn, { operation: op });
  }

  private committed(r: OperationResult): boolean {
    if (r.effect) return true;
    return this.opts.hasCommitted?.(r) ?? false;
  }

  shadowReport(op: string): ShadowReport {
    const sink = this.opts.shadow;
    const recs = sink instanceof MemoryShadowSink ? sink.records.filter((r) => r.operation === op) : [];
    const byPair: Record<string, number> = {};
    for (const r of recs) {
      const k = `${r.legacy.outcome}->${r.modelnativ.outcome}${r.modelnativCode ? `(${r.modelnativCode})` : ""}`;
      byPair[k] = (byPair[k] ?? 0) + 1;
    }
    return { operation: op, total: recs.length, matches: recs.filter((r) => r.match).length, mismatches: recs.filter((r) => !r.match), byPair };
  }
}

function sortKeys(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function createModelnativ(engines: Engine[], opts?: ConstructorParameters<typeof Modelnativ>[1]) {
  return new Modelnativ(engines, opts);
}

export type { OperationResult } from "@modelnativ/runtime";
export type { Principal } from "@modelnativ/contract-schema";
