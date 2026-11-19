# Modelnativ architecture (v0.1, Phase 0)

This document folds four later requirements into the PRD's architecture: §21 (native systems primitives), deterministic testing, embedded adoption, and AI-agent compatibility. Where it differs from the PRD text, the section "Deviations" says so and why.

## 1. One kernel, two host interfaces

```
                 ┌────────────────────── host interfaces ──────────────────────┐
  Standalone:    HTTP ingress (createServer)            Embedded: @modelnativ/core
                 Bearer token -> Identity.verify        mn.execute / mn.bind (host maps its
                                                        authenticated user -> Principal)
                 └──────────────────────────────┬──────────────────────────────┘
                                                ▼
 ┌─────────────────────────────────── Engine (the kernel) ───────────────────────────────────┐
 │ 1 principal + scopes      (before any inference)                                          │
 │ 2 input schema, Idempotency-Key, pre-inference lookup (a retry returns the original)      │
 │ 3 per-resource actor queue + admission control                                            │
 │ 4 facts: request, tools ──mint──▶ PSAP evidence store (class derived from the channel)    │
 │ 5 model proposal: minimised context, budget, timeout, retries   ◀── ModelAdapter          │
 │ 6 gate: schema · version · tenancy · authorization · category rule · provenance ·         │
 │         invariants · binding to {operation, principal, tenant, resource, version}         │
 │ 7 commit: one transaction = idempotency + adapter (version CAS) + effect record + outbox  │
 │    (shadow: same, always rolled back)                                                     │
 │ 8 audit (redacted) + trace (replayable)                                                   │
 │ STALE_STATE at 7 → re-decide once on fresh state (never replay the old proposal)          │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
                                                ▼
                     Dispatcher: outbox → destinations, at-least-once,
                     idempotency key = effect id, secrets resolved per send
```

Every source of nondeterminism comes through `Env`: the clock, ids, the scheduler (yield points between stages 4 to 7), and the fault injector. In production `Env` is the system clock, CSPRNG ids, a free scheduler and no faults. In tests it is a virtual clock, seeded ids, a controlled scheduler and an armed fault plan.

## 2. Module boundaries

| Proposed (update §2) | Phase 0 package(s) | Responsibility |
|---|---|---|
| modelnativ-core (kernel) | `contract-schema`, `contract-compiler`, `gate`, `effect-executor`, `runtime` (Engine, Env, replay) | contracts, authorization, execution, state transitions, deterministic testing |
| modelnativ-runtime (inference) | `model-adapter` | adapters (mock, record/replay, llama.cpp), prompt, budgets |
| modelnativ-node (TS SDK) | `core` (`@modelnativ/core`) | `execute`, `bind`, modes, shadow report |
| modelnativ-cli | `cli` | compile, serve, test, replay, bench, model pull |
| modelnativ-spring-boot-starter | not started | see §5 |

The npm name in the update's sample (`import { modelnativ } from "@modelnativ/core"`) is the SDK, so `@modelnativ/core` is the SDK package here. The kernel packages stay separate so the auditable surface stays small. The names are open (see the report).

## 3. Contract IR (language-neutral)

A contract is a YAML/JSON document validated by a JSON Schema (`contract-schema`), then compiled. Compilation rejects:
- unknown tools and effects;
- undefined variables;
- expressions outside the grammar;
- facts that no channel can establish;
- bounded arguments without an upper bound;
- categories that authorize without a requirement;
- unsupported IR features. A `postconditions` key, for example, is rejected rather than turned into prompt text.

Sections: `input`, `principal`, `tenancy`, `concurrency`, `facts` (reads, with `claims`), `authority` (PSAP grants per channel), `model` (role, `sees`, budget), `decision.categories`, `policy.authorization`, `policy.invariants`, `effects` (args with `established | bounded`), `failure`.

Any SDK in any language consumes the same document and the same proposal schema. The compiled hash is pinned in every audit record and trace.

## 4. Authority model

- **Channels:** the principal (authenticated caller), `tool:<name>`, and the model (`chan:agent-self`, which holds no grant).
- **Grants:** become PSAP capabilities scoped to this operation's subject only.
- **Reading facts:** the gate reads a fact only through `established(p)`, which returns the PSAP operative value when its class is ESTABLISHING, and nothing otherwise.
- **Claims:** a channel's claims about predicates it does not own (customer → `shipment.damaged`) are stored as PROPOSING. They can never outrank the owner's value and never satisfy a requirement.
- **Literals:** a literal the model typed for an `established` argument is minted PROPOSING and accepted only if it exactly equals an established value (exact-string provenance, as in Inbin Gate).

## 5. Embedded mode and the Spring Boot question

`bind()` wraps an existing function with the same signature:

| Mode | What runs |
|---|---|
| `legacy` | Only the original function. |
| `shadow` | The kernel evaluates first, with a dry-run commit; then the legacy function acts and stays authoritative. Normalised outcomes are compared, and inputs are recorded as hashes. |
| `modelnativ` | The kernel decides and acts. |
| `fallback` | The kernel first. Legacy runs only for infrastructure failures (model timeout or error, budget, overload, failed read or rolled-back commit) with no committed effect. A policy refusal or review never falls back, because falling back would bypass the gate. |

Rollback is `setMode(op, "legacy")`.

**Spring Boot.** "One kernel" rules out re-implementing the gate in Java. The candidates are:
1. A local sidecar process (the same TS kernel) over a Unix socket or loopback gRPC. The starter is a thin client, and identity is passed as a signed principal context.
2. Embedding the kernel in-process via GraalJS.
3. A Wasm build of the kernel.

My recommendation is (1) first: it keeps the kernel byte-identical and its process boundary already isolates the model. The cost is a hop and a second process to operate. This choice is yours to make.

## 6. Deterministic testing (built into the kernel)

| Requirement | Where |
|---|---|
| virtual clock, seeded ids, controllable scheduler | `runtime/src/env.ts` |
| model decision replay | `RecordingModel` / `ReplayModel`; `replayTrace()`; `modelnativ replay` |
| concurrency exploration (not seeded) | `exploreSchedules()`: DFS over every choice at yield points; deadlock detection |
| fault injection | `FaultPlan` at named points: `tool.*`, `model.propose`, `engine.beforeCommit`, `executor.beforeCommit`, `outbox.beforeSend`, `outbox.afterSend` |
| contract verification | compiler rejection suite; gate suites; mutation check |
| property-based | `tests/adversarial/properties.test.ts` (fast-check, seeded, non-vacuity asserted) |
| legacy equivalence | shadow mode (embedded); Phase 3 differential runner |
| production replay | traces with recorded tool results, model output and commits; replays production (CSPRNG) traces too |

Deterministic tests never call a live model. Live-model results come only from `bench/` and are reported apart from the tests. Replay reproduces the **decision pipeline** exactly. The commit outcome of a single-trace replay comes from the trace, after checking that the newly bound effect is byte-identical. Whole scenarios, including crashes and retries, are replayed from seed and compared event for event.

## 7. AI-agent compatibility (design constraint only)

Nothing agent-specific is built. The constraints that keep the door open:
- contracts are short, declarative YAML;
- every CLI command has `--json` and stable exit codes (0 ok, 1 failure, 2 usage, 3 environment);
- compiler errors are a list of located problems;
- refusal codes are a closed enum;
- contract, model reasoning and enforcement stay separate.

A next step that helps humans as much as agents is to give compiler problems a `{path, code, message}` shape instead of strings.

## 8. Deviations from the PRD (and why)

1. **Expression language.** A 60-line comparison-only grammar instead of CEL. Policies only need comparisons so far, and the whole surface is visible. Revisit when arithmetic is needed.
2. **Refusal codes.** §21.9 names are used (they supersede §8). §8 codes with no §21.9 equivalent are kept, and `UNESTABLISHED_VALUE`, `MODEL_DECLINED`, `OVERLOADED` and `EXECUTION_FAILED` are added.
3. **Proposal envelope.** It carries a `category` (which rule must hold) instead of a free `reasonCode`, and `{ref}` / `{value}` arguments instead of bare literals.
4. **Expected state version.** §21.1.4 asks the model to carry the expected state version. Here the kernel binds the version from established evidence instead. The model would only be copying a number, and the bound value is the authoritative one.
5. **One effect per proposal** in Phase 0. This avoids aggregate-bound questions, such as two refunds that each pass a cap.
6. **`noUncheckedIndexedAccess` is off**, so the vendored PSAP file stays byte-identical.
7. **Postgres, OIDC, a secret manager and distributed workers** are not in Phase 0. SQLite transactions, HMAC principal contexts, an env/memory secret store and an in-process dispatcher stand in, behind interfaces.
