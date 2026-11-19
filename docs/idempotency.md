# Idempotency: durable claims

Every effectful operation takes an `Idempotency-Key`. The key is scoped to tenant, principal and operation, and is bound to a hash of the canonical request body.

Since this change, **correctness no longer depends on the per-resource in-process queue.** The queue still exists, for fairness and to reduce contention, but every guarantee below holds with it turned off and across processes that share one transactional database.

## Guarantees

| Situation | Answer |
|---|---|
| A key that already has a committed effect, same payload | The committed result: `ALLOW`, `status: duplicate`, same `effectId`, HTTP 200. No model call. |
| Same key, **different** payload: pending, committed, or after a refusal | `REFUSE REPLAY_DETECTED` (409). A key stays bound to its first payload. |
| Same key and payload while another attempt is **in flight** (any process) | Waits for that attempt and returns **its** answer: the committed effect, or the same refusal, review or failure it produced. |
| The in-flight attempt does not finish within `waitMs` | `REFUSE IDEMPOTENCY_IN_PROGRESS` (409, `retryAfterMs`). Nothing is evaluated or written. |
| The request's contract deadline (`reliability.deadlineMs`) comes first | `REFUSE DEADLINE_EXCEEDED` (504) at the deadline |
| More than `maxWaiters` duplicates are already waiting in this engine | `REFUSE IDEMPOTENCY_IN_PROGRESS` (409) immediately: backpressure, retryable |
| The owner **crashed** or stalled past its lease (`leaseMs`) | The next attempt takes the key over and evaluates on fresh state. |
| A stale owner (lease taken over) reaches its decision or its commit | A non-ALLOW decision is discarded in favour of the current owner's answer. At commit, the in-transaction duplicate check turns it into a duplicate of the effect already committed, or the new owner's commit becomes the duplicate. One effect either way. |
| An attempt ends **without** committing (refusal, review, clarify, failure) | Its answer is published to waiters, and the key is released, so a *later* retry re-evaluates. The rule that a retry after a refusal re-evaluates is unchanged. |

At most one effect is ever committed per key. The unique `mn_effects.scoped_key` row is written in the same transaction as the domain write and the outbox, and that transaction also verifies claim ownership.

## How it works

The `mn_claims(scoped_key, request_hash, owner, status, lease_until, outcome_json)` table lives in the application database:

1. **Claim.** One `BEGIN IMMEDIATE` transaction does the following:
   - A committed effect → return it, or `REPLAY_DETECTED` when the hash differs.
   - No claim → insert `pending`, owned by this attempt.
   - A claim with a different hash → `REPLAY_DETECTED`.
   - A `pending` claim with a live lease and another owner → *in flight*.
   - Otherwise (released, or lease expired) → take it over.
2. **Wait** (in flight). This happens **outside** the per-resource queue slot: the slot is held only to claim and evaluate, so a waiting duplicate never blocks unrelated requests for the same resource. Concurrent waiters on one key share **one poller** per process. It polls at `pollMs`, doubling up to `maxPollMs`, until `min(waitMs, deadline)`:
   - committed → return it;
   - released by the attempt we waited on → return its answer;
   - freed, re-owned, or lease expired → try to claim again.
3. **Decide.** Facts, then the model if any, then the gate, exactly as before. A non-ALLOW decision is kept only if this attempt still owns the claim.
4. **Commit.** Inside the transaction: the duplicate backstop runs, then the adapter, the effect row, the outbox and the deletion of the claim.

   An ownership fence at commit was implemented first and then removed. Mutation testing showed no outcome depended on it, because the duplicate backstop already guarantees one effect per key.
5. **Release.** On any final answer without a commit, the owner marks the claim `released` with its answer. An unexpected exception releases it as `EXECUTION_FAILED`. If the process dies, the lease expires.

| Option (`EngineDeps.idempotency`) | Default | Meaning |
|---|---|---|
| `leaseMs` | 30,000 | How long an owner holds a key before another attempt may take it over. Must exceed the longest expected operation, including model inference. |
| `waitMs` | 5,000 | How long a duplicate waits for the owner's answer. |
| `pollMs` | 25 | First poll interval of a waiting duplicate. |
| `maxPollMs` | 200 | Polling backs off (doubling) up to this interval. |
| `maxWaiters` | 256 | Duplicates waiting at once per engine; beyond it, an immediate retryable 409. |

These are set with `createApp(config, dir, { engine: { idempotency: { ... } } })`.

Traces record every key decision (`trace.claims`), and replay serves them in order. Traces written before this change have no `claims` field and replay through the old lookup path.

## Limits

- **One shared transactional database is required.** Separate databases per replica give no cross-replica guarantee. SQLite works across processes on one host (WAL, `busy_timeout`). Across hosts, use a server database. The same SQL works on Postgres, but that has not been tested here.
- **Leases rely on clocks.** A replica whose clock runs far ahead could take over a live claim early. The duplicate backstop still prevents a second effect, but the early taker's answer would win. Keep clocks synchronised (NTP), and keep `leaseMs` well above clock skew plus operation time.
- **A waiting duplicate holds its caller's connection** for up to `min(waitMs, deadline)`, but not a queue slot. At most `maxWaiters` per engine do so; key reads are about one per poll interval per key, not per waiter.
- **A waiter of a `CLARIFY` attempt gets the outcome without the clarification token.** The token is a bearer secret and goes only to the caller that started the attempt.
- **Retention:** `mn_claims` keeps one row per released key, like `mn_effects`. No expiry job exists yet.
- **External effects** are still at-least-once from the outbox. The effect id is sent as the idempotency key to destinations, and exactly-once needs destination support.

## Evidence

`tests/integration/idempotency.test.ts`:

- **Two independent instances** (separate connections, engines and id streams, one SQLite file). Simultaneous duplicates converge on one committed effect in every interleaving (exhaustive).
- **Pending:** a conflicting payload gets `REPLAY_DETECTED`, as it does after commit and after a refusal.
- **Failed:** a waiter gets the owner's `EXECUTION_FAILED`, and a later retry commits once.
- **Timed out:** `IDEMPOTENCY_IN_PROGRESS` (409, Retry-After) with no write; after the owner settles, the retry returns its result.
- **Crash recovery:**
  - a dead owner's claim is not taken over before its lease expires, and is taken over after;
  - a waiter takes over when the lease expires mid-wait.
- **Stale owner:**
  - at decision time: the stale owner would have been refused, so it converges on the new owner's ALLOW;
  - at commit time: the stale owner's gate allows, but it returns the same single effect.
- **Two OS processes** on a real clock, three rounds: one commit per key, and both processes return the same effect.

`tests/differential/approaches.concurrency.test.ts`: the earlier known gap (a same-key retry with per-resource queues off) now gets the same answer in A, B and C, in every schedule.

## Settled outcomes (opt-in prototype: `idempotency.settle: "terminal"`)

**What the default leaves open.** By default (`settle: "release"`), an attempt that ends without an effect *releases* its key, and a later request with the same key re-evaluates. Combined with lease takeover, two callers of one key can get different answers:

1. A stalls past its lease.
2. B takes over and refuses.
3. State changes.
4. A commits.

This is audit finding R4, and `tests/integration/settled-outcomes.test.ts` reproduces it. One effect per key still holds.

**With `settle: "terminal"`:**

| An attempt ends with | The key afterwards |
|---|---|
| A committed effect | Answers with that effect (as before) |
| A **business** refusal (any code except those below) or `REVIEW` | **Settled.** Every later request with the same key and payload gets that same answer, with `answeredBy` = the deciding operation id. Nothing is re-evaluated. A different payload is `REPLAY_DETECTED`. |
| A transient failure (`EXECUTION_FAILED`, `DEADLINE_EXCEEDED`, `MODEL_*`, `RATE_LIMITED`, `OVERLOADED`, `BUDGET_EXCEEDED`, `STALE_STATE`, `IDEMPOTENCY_IN_PROGRESS`) | Released: retry with the same key |
| `CLARIFY` | Released, so the clarification can resume under the same key |

In this mode, the commit also checks that the attempt still owns a *pending* claim. A stale owner is fenced, and it converges on the settled answer. Mutation testing shows this check is load-bearing here. In the default mode it was not, and was removed.

**Client-visible change (why it is not the default).** In `terminal` mode, retrying a refused operation with the **same** key returns the same refusal, even if the cause has since been fixed (for example, stock replenished). A new business attempt must use a **new** key. Clients that reuse a key to "try again" would see a different behaviour. Changing the default needs a decision.

Evidence (`tests/integration/settled-outcomes.test.ts`, 8 tests):

- a settled refusal is returned after the state changed, while a new key re-evaluates;
- the default mode re-evaluates (the compatibility difference);
- a conflicting payload gets `REPLAY_DETECTED`;
- a transient failure is retried with the same key and commits;
- a committed success stays settled;
- the stale-owner scenario diverges in the default mode and converges with nothing committed in `terminal` mode;
- crash takeover still works.

## Policy (decided): declare it in the contract; `terminal` for new operations

```yaml
spec:
  idempotency: { settle: terminal, retentionMs: 604800000 }   # 7 days (the default retention)
```

- **New operations:** declare `settle: terminal`. It is in the authoring template, and `modelnativ lint` lists effectful contracts that do not declare a policy (advisory; it does not fail).
- **Existing contracts keep their behaviour.** A contract without `spec.idempotency` uses the runtime's configured default (`createApp(..., { engine: { idempotency: { settle } } })`), which is `release` unless configured. Nothing changes until a contract opts in or is intentionally migrated. The three migrated examples have not been switched.
- **Precedence:** the contract's declaration, then the runtime configuration, then `release`. The policy is part of the contract, so it is schema-validated, included in the contract hash, and shown by `compile --expanded` (`runtime default` when absent).
- **Retention.** A released key, settled or not, is remembered for `retentionMs` (default 7 days, minimum 1 minute). **After that, a retry with the same key is treated as a new attempt**, with any payload. Committed effects (`mn_effects`) are not subject to this retention: a retry of a committed request returns its effect until the row is removed, and no cleanup job exists yet. `executor.pruneClaims(before)` deletes released claims older than a cutoff and never touches pending ones.
- **Unchanged:**
  - transient infrastructure failures stay retryable under every policy;
  - stale workers stay fenced under `terminal` (commit fence plus no takeover of settled keys);
  - operations with no idempotent effect take no claim at all. Today's schema requires at least one `idempotency: required` effect, so every current operation has one.

Evidence: `tests/integration/idempotency-policy.test.ts` (8 tests).
