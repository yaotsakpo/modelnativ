# Subscription plan change: conventional vs Modelnativ

The primary example. One realistic operation, implemented twice and compared.

| | Where |
|---|---|
| **Conventional reference** | `src/service.ts` (`SubscriptionService.changePlan`), `src/app.ts` (Express API), `test/` (61 tests). Written independently of Modelnativ. |
| **Modelnativ implementation** | `modelnativ/c/plan.change.yaml` (the concise contract you edit), `modelnativ/b/adapters.ts` (reads and writes from primitives), `modelnativ/change-kind.ts` (direction and proration; it reuses the original's proration function), `modelnativ/c/modelnativ.config.ts` |
| **Explicit contract** | `modelnativ/a/plan.change.yaml`, the fully written-out form. `pnpm mn compile --expanded modelnativ/c/plan.change.yaml` prints the same thing. |
| **Embedded SDK binding** | `modelnativ/embedded.ts`: the original `SubscriptionService` interface implemented by Modelnativ, behind the unchanged Express app |

## Run it

```bash
pnpm demo:subscription            # standalone: modelnativ serve --dev (prints a token and a curl command)
pnpm demo:subscription:embedded   # the ORIGINAL Express API with Modelnativ inside (add --conventional for the original service)
pnpm mn review plan.change --app examples/subscription-original/modelnativ/c
```

## Evidence

| What | How | Where |
|---|---|---|
| **Shared tests** | The original's 53 service and HTTP tests run unchanged against both implementations. 52 pass for both; 1 is an intentional difference (below) with its Modelnativ counterpart tested. | `test/`, `tests/shared/subscription.modelnativ.test.ts` |
| **Differential** | 2,500 seeded cases from a 17,280-combination grid, including equal-price plan pairs. Compares outcome, reason, prorated amount, normalised database state and the number of notifications. All identical. | `tests/differential/subscription.diff.test.ts` |
| **Non-default configuration** | Approval threshold and change limit at 5,000/1 and 100,000/3, 600 cases each, through the A, B and C variants. All identical. | `tests/differential/subscription.config.test.ts` |
| **Concurrency** | Exhaustive interleavings: two admins changing one subscription (no lost update; the loser gets `version_conflict`), and the in-transaction version check | `tests/differential/approaches.concurrency.test.ts`, `commit-refusals.test.ts` |
| **Duplicates and processes** | Idempotency across two runtime instances and two OS processes (loyalty example, same kernel path) | `tests/integration/idempotency.test.ts` |

Equivalence is shown on these samples and tests, **not proven for all inputs**.

**What is compared:**

- outcome and rejection reason;
- the prorated amount;
- `subscriptions` (plan, version);
- invoice items and credit notes (subscription, amount);
- plan-change history (from, to, direction, amount, actor);
- approval requests (from, to, amount, requester, status);
- the billing notifications sent (count, and in the shared tests, content).

**Not compared:** row ids, timestamps, description text.

## Intentional differences

| Area | Conventional | Modelnativ | Verified? |
|---|---|---|---|
| Idempotency | No key; a retry re-executes | A key per request. A retry returns the committed result; concurrent duplicates converge. The embedded binding generates a fresh key per call, because the original API has none. | Tests |
| Billing notification | Fire-and-forget after commit, one attempt, a failure logged | Transactional outbox: delivered after commit, retried with backoff, then dead-lettered (at-least-once) | Tests (shared counterpart test) |
| Ids | Random UUIDs | Derived from the effect id (`eff_…`); the approval request id is the effect id | By inspection |
| Concurrent change **with** `expectedVersion` | `version_conflict` | `version_conflict` | Tests |
| Concurrent change **without** `expectedVersion` | `version_conflict` | The kernel re-decides once on fresh state, so it may apply the change | **Inferred from code; not tested** |
| Infrastructure failure (e.g. a database error during commit) | The raw error is thrown | `ModelnativRetryableError` is thrown (embedded). Nothing is committed; the original app's error handler answers 500 as before. | Shared tests (rollback) |
| A subscription referencing an unknown plan (corrupt data) | Throws | Facts unestablished, so a refusal rather than an exception | **Not tested** |
| Standalone HTTP (`modelnativ serve`) | `POST /subscriptions/:id/plan-change`, statuses 200 / 202 / 403 / 404 / 409 / 422 | `POST /v1/plan.change` with Modelnativ's body and statuses (e.g. 201 for a committed change). **Not the same API.** Use the embedded SDK to keep the original API. | Demo test |
| Observability | Logger warnings | Audit record, replayable trace, observed-effects manifest | Tests |
