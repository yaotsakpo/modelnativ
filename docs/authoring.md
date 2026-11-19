# Writing an operation

**Recommended for new operations:** a concise contract (`kind: ConciseOperation`) plus adapters built from the framework primitives (`sqlRead`, `sqlEffect`, `configFacts`).

**Fully supported, never deprecated:** explicit contracts (`kind: Operation`) and hand-written read tools and effect adapters. Every concise contract compiles to an explicit one. You can mix both styles in one app, and even inside one operation (for example, primitives for the SQL steps and a hand-written adapter for an HTTP call).

Why this is the recommendation: an internal comparison of the three styles (explicit contracts, primitives, concise contracts) on three workflows. Behaviour, safety and runtime were the same in the A/B/C comparison. The concise style needed 23–40% fewer authored lines, and some mistakes surface at startup instead of at runtime.

## 1. The contract

```yaml
apiVersion: modelnativ.dev/v1alpha1
kind: ConciseOperation
metadata: { name: loyalty.redeem, version: 1, summary: Redeem loyalty points for a reward }
spec:
  input: { ... JSON Schema ... }
  principal: { scopes: ["loyalty:redeem"] }
  tenancy: { key: acct.tenantId, code: not_found }
  concurrency: { key: request.rewardId }
  idempotency: { settle: terminal }      # recommended for new operations (idempotency.md)
  reads:
    accounts.mine: { args: { member: principal.subject, tenant: principal.tenant }, provides: [acct.memberId, acct.points, ...], establishes: [acct.*] }
    policy.get:    { provides: [policy.dailyLimit], establishes: [policy.*] }
  decision:
    source: { mode: fixed, category: REDEEM }
    evaluation: sequential               # first failing rule decides, in this order
    categories:
      REDEEM:
        effect: loyalty.redeem.apply
        requires:
          - "acct.status == 'active'": inactive
          - "today.count < policy.dailyLimit": daily_limit
  effects:
    loyalty.redeem.apply:
      args: { memberId: acct.memberId, dailyLimit: { from: policy.dailyLimit, type: integer } }
```

- Every default and expansion is listed in [concise-contracts.md](concise-contracts.md).
- `modelnativ compile --explain <file>` shows what the compiler added.
- `--expanded` prints the explicit contract that is hashed and run.
- Authority is always written (`establishes`). Rules and permissions are never inferred.

## 2. Reads and effects

```ts
sqlRead(db, {
  name: "rewards.get",
  sql: "SELECT id, stock, min_tier, cost FROM rewards WHERE id = ? AND tenant_id = ?",
  params: ["rewardId", "tenant"], tenantParam: "tenant",
  facts: { "reward.id": "id", "reward.stock": "stock", "reward.totalCost": (r, a) => Number(r.cost) * Number(a.quantity) },
  derive: [{ facts: ["change.direction", "change.kind"], compute: (row, args) => ({ ... }) }],   // several facts, computed once
});

sqlEffect({
  tool: "loyalty.redeem.apply",
  steps: [
    { check: "SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?", params: (c) => [...],
      assert: (r, c) => Number(r?.n) < Number(c.args.dailyLimit), refuse: { code: "INVARIANT_VIOLATION", reason: "daily_limit" } },
    { write: "UPDATE rewards SET stock = stock - ? WHERE id = ? AND stock >= ?", params: (c) => [...],
      refuse: { code: "INVARIANT_VIOLATION", reason: "out_of_stock" } },   // must change exactly 1 row, else refuse + roll back
  ],
  result: (c) => ({ ... }), outbox: (c) => [{ destination: "fulfillment", payload: { ... } }],
});

configFacts("policy.get", { "policy.dailyLimit": 3 });   // business constants as established facts
```

Startup checks, all with actionable messages:

- **Columns:**
  - every mapped column must be a result column of the query; aliases count;
  - an unaliased expression must be aliased;
  - a column name returned twice by a JOIN is ambiguous;
  - near-miss names are suggested.
- **SQL that doesn't prepare:** every `sqlRead` and `sqlEffect` statement must prepare.
- **Missing tables:** if a table does not exist yet, the checks run on first use instead.
- **Drift:** a tool that does not provide a fact the contract expects is rejected (the `provides` check).

## 3. Business constants: one source

A number that decides in a contract rule must not be repeated in adapter code: the two copies drift silently. Make it one established fact, and pass it to the adapter as an effect argument:

- `configFacts("policy.get", { "policy.dailyLimit": 3 })`, or a config-backed read tool when the value is configurable per deployment (as in the subscription example: `makeApp({ approvalThresholdCents, maxPlanChangesPerPeriod })`);
- the rule `today.count < policy.dailyLimit`;
- the effect argument `dailyLimit: { from: policy.dailyLimit, type: integer }`, used by the adapter's in-transaction re-check.

The value in force is recorded in every decision's evidence.

`modelnativ lint <appDir>` reports numbers that appear both in a contract rule and in a comparison in the app's TypeScript, either directly or through a named constant. It is a heuristic: it reports candidates, and a person decides. It exits 1 when it finds any.

## 4. Running it

`createApp(config, dir, { env, db, ... })`.

**Idempotency:** durable claims in the shared database ([idempotency.md](idempotency.md)). Correctness does not depend on the per-resource queue.

**Audit and traces.** Without explicit stores, the newest 10,000 audit records and 1,000 traces are kept in memory. Older ones are dropped and counted (`dropped`). That is for development and tests, **not retention**. When records must be kept, pass a durable `audit` sink and `traces` store: `FileAudit` and `DirTraces`, which `modelnativ serve` uses, or your own implementation, such as an append-only table or a log pipeline. Your audit retention policy is then the policy of that store.

## Explicit contracts

Use `kind: Operation` when you want every block written out: for reference contracts, reviews that should not depend on knowing the defaults, or generated contracts. The compiler adds nothing to them: a missing required block is an error. Concise syntax inside an explicit contract is rejected with a message pointing at `kind: ConciseOperation`.
