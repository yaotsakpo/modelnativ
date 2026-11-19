# Known limitations (developer preview)

Modelnativ is a **developer preview**. This page lists what it does not do, or has not shown. If something here matters to you, assume it does not work until it is listed elsewhere with evidence.

## Status

- **Not production software.** It has not been deployed in production. There are no compatibility guarantees between commits.
- **Repository-only.** No npm packages are published. The packages export TypeScript source and run through `tsx`.

## Platforms

- **Tested:** macOS (arm64) with Node 20 and 22.
- **CI** runs Ubuntu and macOS with Node 20 and 22. Until the first CI run is green, Linux counts as unverified.
- **Not tested:** Windows, and Node 18 or older (excluded by `engines`).

## Behaviour and equivalence

- **Equivalence is sampled.** It is shown on the listed test cases and differential samples (see each example's README), not proven for all inputs.
- **Intentional differences** from the conventional implementations are listed per example: idempotency keys, at-least-once outbox delivery, typed infrastructure errors, and a different standalone HTTP API.
- **Untested inferences:**
  - a concurrent change **without** `expectedVersion` may be applied after one re-decision, where the conventional service reports a conflict;
  - corrupt data (a reference to a missing plan) produces a refusal rather than an exception.

## Data and deployment

- **SQLite only.** Postgres and other databases are untested.
- **One shared database** is required for any cross-process guarantee: idempotency, claims and outbox leases. Multi-process behaviour is tested on one host. Across hosts, idempotency leases depend on reasonably synchronised clocks.
- **External delivery is at-least-once.** Destinations must de-duplicate by the effect id sent as the idempotency key. A send that takes longer than the outbox lease (60 s) can be duplicated. There is no per-send timeout, and nothing alerts on dead letters.
- **Audit is written after the commit.** A crash between the commit and the audit write keeps the effect but loses that operation's audit record and trace.
- **No retention or cleanup** for the kernel tables (`mn_*`), `FileAudit` or `DirTraces`. `executor.pruneClaims()` exists, but nothing calls it automatically.
- **`modelnativ serve` is a development server:**
  - no TLS, request concurrency limit or readiness endpoint;
  - it stops on SIGINT or SIGTERM without draining in-flight work;
  - `--dev` must never be exposed.

## Review tooling

- `modelnativ review` shows what primitives declare and what recorded test runs executed. **Hand-written code, helper functions, constants and external calls are flagged, not analysed.**
- Observed-effect manifests must be regenerated when code changes (`bench/review/observe.ts`). A stale manifest is detected and ignored, but not refreshed automatically.
- **No reviewability claim.** No human study of review speed or accuracy has been completed.

## Models

- The optional local-model path (free-text decisions; the refund example) is experimental, and its accuracy is limited.
- The kernel bounds what a model can cause, but cannot check whether it understood the text.
