# Runtime reliability: retries, deadlines, limits, backpressure, circuit breaking

All of these are enforced by the runtime, never by the model. Every primitive takes time and randomness from `Env`, so under a `VirtualClock` and a seed the behaviour is exactly reproducible: backoff delays, admission decisions and breaker transitions. Code: `packages/reliability`. Engine integration: `packages/runtime/src/engine.ts`. Tests: `packages/reliability/test`, `tests/integration/reliability.test.ts`.

## Where each control is configured

| Control | Configured in | Why there |
|---|---|---|
| Request deadline | contract `spec.reliability.deadlineMs` | A property of the operation |
| Model-call retries and breaker | contract `spec.reliability.model` | Depends on how the operation tolerates delay |
| Tool timeouts and retries | contract `spec.reliability.tools` | Same |
| Output re-ask on unparseable model output | contract `spec.model.budget.maxRetries` (unchanged) | A different thing: bad output, not a transport failure |
| Rate limits (tenant / principal / operation / API key) | runtime config (`Limiter`, shared per process) | Operator policy; must span operations |
| Max concurrent inference, queue bounds, fairness | runtime config (`FairScheduler`, shared) | A property of the hardware |
| Durable effect delivery | dispatcher options (`policy`, `breaker`) | Per destination, not per operation |

```yaml
reliability:
  deadlineMs: 10000
  model:
    retry:   { maxAttempts: 2, baseMs: 100, maxMs: 1000, jitter: full }
    breaker: { failures: 5, windowMs: 30000, openMs: 15000 }
  tools:
    timeoutMs: 2000
    retry:   { maxAttempts: 3, baseMs: 50, maxMs: 500, jitter: full }
```

The compiler validates this block. Omitting it means no retries, no deadline beyond the model's per-call timeout, and no breaker: the Phase 0 behaviour.

## Three kinds of retry, deliberately separate

| | What is retried | Classified retryable | Never retried |
|---|---|---|---|
| **Model inference** | the adapter call, after a transport failure or per-attempt timeout (the slow call is cancelled via `AbortSignal`) | errors flagged `retryable: true`; per-attempt timeouts | errors without the flag (fail closed); anything after the deadline |
| **Tool reads** | the read call | flagged errors; tool timeouts; injected network/timeout faults | DB or crash faults; anything after the deadline |
| **Effect delivery** (outbox) | sending a *committed* effect to its destination | everything except errors flagged `retryable: false` | the commit itself |

Two properties hold by construction:
- **Policy refusals are never retried.** Retries wrap only the transport call (adapter, tool, destination). The gate, the category rules and the invariants run outside every retry loop. Tested: an over-limit proposal with a 3-attempt policy produces exactly one model call.
- **Committed effects are never duplicated.** The commit is not wrapped in any retry. Delivery retries carry the effect's id as the idempotency key, and the receiver de-duplicates (the conformance and crash tests). A client retrying the whole request gets the original result via the scoped idempotency key, with no model call.

**Backoff.** Exponential, `cap = min(maxMs, baseMs · 2^(n−1))`, with jitter:
- `full`: uniform in [0, cap];
- `equal`: [cap/2, cap], the dispatcher default, so a retry is never immediate;
- `none`: exactly cap.

Retries never sleep past the deadline.

## Deadlines and cancellation

`Deadline` exposes `remaining()` and an `AbortSignal`. Inference attempts race `min(per-call timeout, remaining)`; on timeout the attempt's signal aborts the inference (the llama adapter passes it to the runtime). A deadline that passes anywhere returns `DEADLINE_EXCEEDED` (HTTP 504) with nothing committed. Queue waits in the inference scheduler also respect it.

## Rate limits and backpressure

- **Token buckets** keyed by tenant, principal, operation or API key (`Principal.keyId`). Every configured rule must admit; a refusal by one rule spends no tokens of another. The key space is LRU-bounded. Refusal: `RATE_LIMITED`, HTTP 429, `Retry-After`. **Checked before any inference.**
- **Inference scheduler** (`FairScheduler`):
  - `maxConcurrent` inferences;
  - bounded total and per-tenant queues;
  - slots granted round-robin across tenants, so one tenant's burst cannot starve another (tested: a second tenant is served within the first 3 grants despite a 10-request burst);
  - a full queue refuses immediately with `OVERLOADED`, HTTP 429 and a `Retry-After` estimate (from the observed slot hold time);
  - a waiter whose deadline passes is removed.
- **Per-resource actor queue:** unchanged from Phase 0, now also returns `Retry-After` on `OVERLOADED`.

## Circuit breakers

**Model breaker (per operation).** Opens after N dependency failures within a window, then fails fast with `MODEL_UNAVAILABLE`, HTTP 503 and `Retry-After`. After `openMs` it allows one probe: success closes it, failure re-opens it. Overload and deadline errors do not count. The embedded SDK's `fallback` mode treats `MODEL_UNAVAILABLE` as eligible: the legacy path serves, and nothing was committed.

**Destination breaker (dispatcher).** While open, due messages are deferred without spending an attempt, so a failing provider is not hammered into dead-lettering everything. A non-retryable rejection (e.g. 400) does not trip it.

## Crash recovery and replay

- **Failed attempts are recorded in the trace**, for tools and model calls alike, with absent fields omitted so traces survive a JSON round trip. Trace replay re-raises them in order and drives the engine on the virtual clock, so the seeded backoff is reproduced exactly. Tested on in-memory and JSON-round-tripped traces.
- **Durable delivery:** attempts and the next due time live in `mn_outbox`, in the same database as the effect. A restarted dispatcher resumes from there.

## Not done (limitations)

- **Limits are per process.** Several replicas need a shared counter store. Postgres can do it; Redis is a legitimate option for counters only, never for authorization (see `caching-evaluation.md`). Not built.
- **No priority classes** beyond per-tenant fairness. No weighted fairness.
- **No load test on real hardware yet** with concurrent live inference. The scheduler is verified with deterministic tests only.
- **No circuit breaker on read tools** (only retries and timeouts).
- **The model breaker is per Engine (per operation)**, not shared across operations using the same model server. Inject a shared `modelBreaker` to share it.

## Records written after the outcome (audit, trace, status)

The commit transaction holds the domain writes, the effect record (`mn_effects`) and the outbox. **The audit record, the trace and the operation status are written after it**, outside the transaction.

- **A failure writing them never changes the outcome.** A committed effect is reported as committed. The failure appears as `result.observability.failed` (`audit` | `trace` | `status`), and the `onObservabilityFailure` engine hook is called. A throwing hook is ignored.
- **The HTTP server answers every request.** An unexpected exception becomes a 500 `{ outcome: "ERROR", code: "INTERNAL_ERROR" }` with no internal detail, and is passed to `createServer(..., { onError })`. Before this change, Express 4 left the request hanging, and the unhandled rejection terminated the process.
- **Limitation (non-transactional audit).** If the process dies between the commit and these writes, the effect exists but its audit record and trace do not, and `mn_operations` stays `received`. What survives:
  - `mn_effects`: the operation id, the request hash and the result;
  - `mn_outbox`;
  - the domain rows.

  A retry with the same key returns the committed result. The *why* (evidence, rule checks, proposal) of that one operation is lost. Writing the audit record inside the commit transaction would close this window, at the cost of putting audit in the application database. Not done.

Evidence: `tests/integration/post-commit.test.ts`. It covers sink failures, a throwing hook, the HTTP 201 and 500 paths with no unhandled rejection, and a crash after commit via the `engine.afterCommit` fault point, followed by recovery on a fresh instance.

## Embedded results: business answers vs infrastructure failures

`classify(result)` from `@modelnativ/core` returns one of:

- `committed`;
- `business_refusal` (`REFUSE` decided by the contract, gate or adapter, with its `reason`);
- `review`;
- `clarify`;
- `retryable` (`REFUSE` with a transient code: `EXECUTION_FAILED`, `DEADLINE_EXCEEDED`, `RATE_LIMITED`, `OVERLOADED`, `IDEMPOTENCY_IN_PROGRESS`, `STALE_STATE`, `MODEL_*`, `BUDGET_EXCEEDED`). Nothing was committed by that call.

**`bind`** (default `onInfrastructure: "throw"`):

- `retryable` outcomes throw `ModelnativRetryableError` (`code`, `retryAfterMs`, `result`). They do not reach the host's `output` mapping, so the host's existing error handling applies, as it did when the original service threw. Previously, an `output` written for business answers turned outages into business refusals; the loyalty binding returned `rejected: not_found` (422).
- Exceptions from the kernel throw `ModelnativUnexpectedError`.
- **Compatibility:** hosts that relied on `output` receiving every outcome pass `onInfrastructure: "output"`.

**`fallback` mode** runs the legacy function only when all of these hold:

- the outcome is fallback-eligible;
- the failure was evaluated by *this* call, not a converged copy (`answeredBy`), whose owner already fell back;
- the key has no committed effect (`engine.findCommitted`). If an effect is committed, that effect is returned instead.

An unexpected exception never falls back, because an effect may be committed.

**Standalone HTTP:** 5xx bodies omit `detail` (internal error text). It stays in audit and trace.

Evidence: `tests/integration/embedded-results.test.ts`.
