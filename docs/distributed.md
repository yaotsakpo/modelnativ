# Process-local vs distributed: what changes with more than one replica

Today Modelnativ runs as **one process with one SQLite database**. Every guarantee below is tested in that setting. This document lists each mechanism, whether it is process-local, what breaks or degrades with several replicas, and what a distributed deployment needs. Nothing here is built yet.

## Summary

| Mechanism | Today | With N replicas, as-is | Correctness at risk? | What a distributed deployment needs |
|---|---|---|---|---|
| Idempotency (`mn_claims` lease + `mn_effects`, scoped key + request hash) | SQLite: durable claim (`BEGIN IMMEDIATE`) before evaluation, duplicate check inside the commit transaction | Works if all replicas share **one transactional DB**. Concurrent duplicates converge on one answer across processes (tested with two OS processes); see [idempotency.md](idempotency.md). | No, *if* the DB is shared and clocks are roughly synchronised (lease takeover) | Postgres (or another DB with transactions). Same tables; the claim is one transaction with a row lock. |
| Version check on state (CAS in the adapter) | SQLite `UPDATE … WHERE version=?` | Same | No | Same, on the shared DB. Exhaustive exploration with actors off already shows the CAS alone preserves the invariant. |
| Per-resource actor queue | In-process map of promise chains | Each replica serialises only its own requests | **No** (the CAS is the cross-replica guarantee); more `STALE_STATE` re-decisions, i.e. wasted inference | Optional: route by resource key (consistent hashing) to cut conflicts, or take `SELECT … FOR UPDATE` / advisory locks just before commit. Never hold a lock across inference. |
| Outbox + dispatcher | Single-flight `drain()` per dispatcher; each row leased (`lease_owner`, `lease_until`, default 60 s) before sending; updates fenced by the lease | Replicas never send one row concurrently. A row whose dispatcher crashed is re-sent after its lease expires. A send slower than the lease can be duplicated; the late ack is fenced (`leaseLost`). | No duplicate *effects* (receivers de-duplicate by effect id); duplicate *calls* only after a crash or a send longer than the lease | Same columns on Postgres (`UPDATE … WHERE lease_until <= now()` or `FOR UPDATE SKIP LOCKED`). Keep `leaseMs` above the slowest destination timeout. |
| Pending clarifications (`mn_pending`) | SQLite; atomic single-use claim | Works on a shared DB | No, *if* shared | Same table on Postgres; the claim is one conditional `UPDATE`. Add a sweeper for expired rows. |
| Rate limits (`Limiter`, token buckets) | In-memory per process | Each replica admits its own full quota: the effective limit is N× | **Yes** for quotas (fairness and cost), never for authorization | A shared counter store: Postgres (`UPDATE … RETURNING` on a bucket row) or Redis (atomic Lua script). Or split each limit N ways per replica (simple, approximate). |
| Inference scheduler (`FairScheduler`) | In-memory per process | Concurrency is per replica (that matches per-GPU reality); fairness is per replica only | No | Per-node scheduling is right when each node has its own model. With a shared inference service, fairness and queueing move into that service. |
| Model circuit breaker | Per Engine (per operation) per process | Each replica learns separately that the model is down | No (only slower to trip) | Usually fine per node. Share it only with a central inference service. |
| Destination breaker | Per dispatcher | Same | No | Same |
| Deadlines | Process clock | Clock skew between replicas | No (relative timers within one process) | Nothing, as long as deadlines stay in-request. Absolute expiries (clarification TTL, outbox `next_attempt_at`) should use the DB clock (`now()`) when replicas share a DB. |
| Model, KV prefix cache, chat sessions | Per process (GPU state) | Each replica warms its own | No | Nothing; or route by contract to a warm node. |
| Audit / traces | Memory or local files | Scattered across nodes | No (observability only) | Ship audit to an append-only store (or write it in the commit transaction); traces to an object store, keyed by trace id, access-controlled (they contain customer data). |
| Identity signing key | Secret store per process | Must match across replicas | Yes, if keys diverge (tokens from one replica rejected by another) | A shared secret manager; key ids (`kid`) in tokens for rotation. |
| Contracts | Compiled in-process from files | Replicas could run different versions during a rollout | Partly: pending clarifications and idempotency keys are bound to the contract hash, so a version mix fails closed (`CLARIFICATION_INVALID`, a fresh decision) | Versioned rollout; pin a version per request; keep the old version live until its pending operations expire. |

## What stays correct across replicas, by construction

- **Authorization, provenance, tenancy and invariants** are evaluated per request from fresh reads and re-checked inside the commit transaction. They share no in-memory state.
- **No duplicate effect for one idempotency key**, given a shared transactional DB: the unique key and the in-transaction check.
- **One answer per idempotency key** for concurrent duplicates: the durable claim (not the in-process actor) makes later duplicates wait for the owner's answer. Tested with two runtime instances and with two OS processes sharing one SQLite file.
- **No double spend**: the version check in the commit, proven for all 70 interleavings with actors off.
- **Clarification tokens are single-use**: one conditional `UPDATE` on the shared DB.

## What degrades without new work

- **Rate limits** become N× looser. This is the only real policy gap.
- **More conflict re-decisions** under contention: wasted inference, not wrong results.
- **Duplicate dispatch calls** without leases: wasted calls; the receiver de-duplicates.

## Minimal path to a multi-replica deployment

1. **Postgres adapter** for executor, outbox and pending (same schema; `SKIP LOCKED` claiming for the outbox).
2. **Shared rate-limit counters** in Postgres first. Redis only if measured contention justifies it, and only for counters.
3. **A shared secret manager** with key ids for identity tokens.
4. **Use the DB clock** for absolute expiries.
5. **Contract version pinning** during rollout.
6. **Re-run the conformance and concurrency suites** against Postgres, with two dispatcher workers and two engines on one DB.
