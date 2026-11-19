/**
 * Trace replay (production replay, PRD testing req. 2 and 8).
 *
 * Re-runs one operation's DECISION PIPELINE exactly: same principal, request,
 * clock, id stream, recorded tool results and recorded model output. No live
 * model, no database. The commit outcome is served from the trace, after
 * checking that the effect the gate binds now is identical to the one it bound
 * then. A divergence anywhere (different evidence, a model-input hash miss, a
 * different gate result or binding) is reported, not papered over.
 */
import type { CompiledContract } from "@modelnativ/contract-compiler";
import type { BoundEffect } from "@modelnativ/gate";
import { ReplayModel, type ModelRecord } from "@modelnativ/model-adapter";
import { MemoryAudit, MemoryTraces, type TraceRecord } from "@modelnativ/observability";
import type { CommitResult } from "@modelnativ/effect-executor";
import { canonicalJson as canon } from "@modelnativ/contract-schema";
import { Engine, type Committer, type OperationResult, type ReadTool } from "./engine.ts";
import { NO_FAULTS, ReplayedFailure, SeededRandom, VirtualClock, drive, freeScheduler } from "./env.ts";
import { RetryableError } from "@modelnativ/reliability";

export class ReplayDivergence extends Error {}

/** Re-issues the operation id the original run generated (production ids come from the OS CSPRNG). */
class RecordedIds extends SeededRandom {
  constructor(private opId: string) {
    super(0);
  }
  override id(prefix: string): string {
    if (prefix !== "op") throw new ReplayDivergence(`unexpected id request "${prefix}" during replay`);
    return this.opId;
  }
}

export async function replayTrace(
  trace: TraceRecord,
  contract: CompiledContract,
  toolNames: string[],
): Promise<{ result: OperationResult; replayed: TraceRecord; identical: boolean; diffs: string[] }> {
  if (trace.contractHash !== contract.hash) throw new ReplayDivergence(`contract hash differs: trace ${trace.contractHash.slice(0, 12)} vs ${contract.hash.slice(0, 12)}`);
  // The engine turns read and commit errors into EXECUTION_FAILED; a divergence must not be absorbed that way.
  let divergence: ReplayDivergence | null = null;
  const diverge = (msg: string): never => {
    divergence ??= new ReplayDivergence(msg);
    throw divergence;
  };
  const clock = new VirtualClock(trace.clockStart);
  const toolQueue = [...trace.toolResults];
  const tools: ReadTool[] = toolNames.map((name) => ({
    name,
    async read(args) {
      const i = toolQueue.findIndex((t) => t.tool === name);
      if (i < 0) return diverge(`tool ${name} called more times than recorded`);
      const [rec] = toolQueue.splice(i, 1);
      if (canon(rec!.args) !== canon(args)) return diverge(`tool ${name} called with different args`);
      const failed = rec as unknown as { error?: string; retryable?: boolean; code?: string };
      if (failed.error !== undefined) throw new RetryableError(failed.error, failed.retryable === true, failed.code);
      return rec!.result as Record<string, unknown> | null;
    },
  }));
  const lookups = [...trace.lookups];
  const commits = [...trace.commits];
  const committer: Committer = {
    lookup: () => {
      if (!lookups.length) diverge("more idempotency lookups than recorded");
      return (lookups.shift() ?? undefined) as ReturnType<Committer["lookup"]>;
    },
    commit: (effect: BoundEffect) => {
      const rec = commits.shift();
      if (!rec) return diverge("gate allowed an effect the original run did not commit");
      if (canon(rec.effect) !== canon(effect)) return diverge(`bound effect differs from the recorded one: ${canon(effect)}`);
      if (rec.error) throw new ReplayedFailure(rec.error);
      return rec.result as CommitResult;
    },
    recordOperation: () => {},
  };
  // Traces from the durable-claim path carry every key decision; serve them in order.
  if (trace.claims) {
    const claims = [...trace.claims];
    const next = (what: string) => {
      if (!claims.length) diverge(`more idempotency ${what}s than recorded`);
      return claims.shift() as ReturnType<NonNullable<Committer["claimKey"]>>;
    };
    // Waiters record the claim and the FINAL key state only (polls are coalesced and backed off).
    // A replayed poll before that state is "still in flight"; a timed-out waiter recorded none.
    let lastInflight: unknown = null;
    committer.claimKey = () => {
      const c = next("claim");
      if ((c as { kind: string }).kind === "inflight") lastInflight = { ...(c as object), leaseUntil: Number.MAX_SAFE_INTEGER };
      return c;
    };
    committer.peekKey = () => (claims.length ? next("peek") : ((lastInflight ?? next("peek")) as ReturnType<NonNullable<Committer["peekKey"]>>));
    committer.releaseKey = () => {};
    committer.ownsKey = () => (next("ownership check") as unknown as { owns: boolean }).owns;
  }
  const traces = new MemoryTraces();
  const engine = new Engine({
    env: { clock, random: new RecordedIds(trace.traceId.replace(/^tr_/, "op_")), scheduler: freeScheduler, faults: NO_FAULTS },
    contract,
    model: new ReplayModel(trace.model as ModelRecord[]),
    tools,
    executor: committer,
    audit: new MemoryAudit(),
    traces,
    serialize: false,
    seed: trace.seed,
  });
  const req = trace.request as { body: unknown; idempotencyKey: string | null };
  // Driven on the virtual clock: recorded retries sleep their (seeded) backoff deterministically.
  const result = await drive(engine.handle({ principal: trace.principal as never, body: req.body, idempotencyKey: req.idempotencyKey }), clock);
  if (divergence) throw divergence;
  const replayed = traces.get(result.traceId)!;
  const diffs: string[] = [];
  for (const k of ["outcome", "toolResults", "model", "commits", "lookups", "claims"] as const)
    if (canon(trace[k] ?? null) !== canon(replayed[k] ?? null)) diffs.push(k);
  if (replayed.traceId !== trace.traceId) diffs.push("traceId");
  return { result, replayed, identical: diffs.length === 0, diffs };
}
