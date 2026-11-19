# Quickstart

About ten minutes. You need Node 20 or 22, git, and pnpm 9 through corepack. Nothing else: no database server, no model, no network service.

## 1. Install

```bash
git clone https://github.com/yaotsakpo/modelnativ.git && cd modelnativ
corepack enable
pnpm install            # the local-model runtime is not installed (not needed here)
pnpm typecheck
pnpm test               # fast deterministic suite
```

## 2. Read the operation, without reading its code

```bash
cat examples/subscription-original/modelnativ/c/plan.change.yaml            # the contract you edit

pnpm mn review plan.change --app examples/subscription-original/modelnativ/c
#   rules in evaluation order, who may act, reads, derived values, writes, sends,
#   idempotency, failure classes, evidence, and NOT VERIFIED (what the tool cannot vouch for)

pnpm mn review plan.change --app examples/subscription-original/modelnativ/c --detail   # + SQL, bound values, defaults
pnpm mn compile --explain  examples/subscription-original/modelnativ/c/plan.change.yaml # every default the compiler applied
pnpm mn compile --expanded examples/subscription-original/modelnativ/c/plan.change.yaml # the explicit contract that runs
```

## 3. Run it

**Standalone server**, for local experiments only. `--dev` uses an ephemeral signing key and prints a demo token plus a ready-to-run `curl` command:

```bash
pnpm demo:subscription
# in another terminal: paste the printed curl command -> 201 {"outcome":"ALLOW", ... "status":"changed" ...}
# paste it again within the same second (same idempotency key) -> 200, "duplicate"
```

To serve without `--dev`, provide a signing key:

```bash
MN_SECRET_INGRESS_SIGNINGKEY=$(openssl rand -hex 32) pnpm mn serve examples/subscription-original/modelnativ/c --port 8080
```

**Embedded SDK.** The original Express API (its controller, routes, auth and HTTP mapping) runs with Modelnativ inside:

```bash
pnpm demo:subscription:embedded                  # Modelnativ
pnpm demo:subscription:embedded --conventional   # the original service, for comparison
# paste the printed curl command -> 200 {"status":"changed", ...}
```

## 4. Compare with the conventional implementation

```bash
pnpm test:slow
#   shared tests: the original's service and HTTP tests run against both implementations
#   differential: 2,500 cases + two configurations, comparing outcome, reason, amount, state and notifications
#   exhaustive concurrency, multi-process idempotency, failure injection
```

To run only the subscription comparison for the concise contract you edit (`modelnativ/c`):

```bash
pnpm exec vitest run tests/shared examples/subscription-original/test                        # shared tests, seconds
MN_TEST=all pnpm exec vitest run tests/differential/approaches.test.ts -t "subscription C"   # differential, ~1 min
```

(`tests/differential/subscription.diff.test.ts` runs the same differential on the explicit contract in `modelnativ/a`.)

## 5. Change something and watch the evidence react

1. In `modelnativ/c/plan.change.yaml`, swap the preconditions `invoice_pending` and `plan_change_limit_reached`. Then:
   - the shared tests fail on "invoice_pending beats the change cap";
   - the differential for the C contract (above) reports the cases where the order now changes the answer (2,449 of 2,500 identical).

   Revert the swap.
2. In `modelnativ/b/adapters.ts`, add `member` to the roles in `member.canChangePlan`. Run `pnpm mn review …`: the DERIVED line shows the new role set. The shared tests fail on "forbids a plain member". Revert the change.
