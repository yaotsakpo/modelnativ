# Decision routing: deterministic, model-assisted, hybrid

AI inference is optional. A contract declares where its decision category comes from:

```yaml
decision:
  source:
    mode: hybrid            # model (default) | field | hybrid
    field: request.reason   # a request fact: the caller's own structured statement
    values:                 # external enum -> category (default: identity over category names)
      DAMAGED_ITEM: DAMAGED
      NEVER_ARRIVED: NOT_DELIVERED
      NO_LONGER_WANTED: CHANGED_MIND
      OTHER: OTHER
```

| Mode | Category from | Model called | `spec.model` |
|---|---|---|---|
| `model` (default; existing contracts unchanged) | the model's proposal | always | required |
| `field` | the caller's structured field | **never** | optional |
| `hybrid` | the field when present and valid; otherwise the model | only without a structured value | required |

## One kernel, one gate

Only the *decide* step forks:

```
identity -> rate limit -> input schema -> idempotency -> facts (PSAP) ->
  decide:  field  -> proposal built from the contract (no model, no confirmation)
           model  -> model proposal (+ intent policy confirmations)
-> gate(contract, evidence, proposal, source) -> commit / CLARIFY / REVIEW / REFUSE
```

- **The runtime decides the route** from the contract and the *established* request field. The gate is told the source by the runtime, never by the proposal.
- **On the field path, the gate re-derives the category** from the established field and refuses any mismatch (`SCHEMA_INVALID`). A runtime bug cannot smuggle a different category through.
- **Everything else is identical on both paths:**
  - authorization and tenancy;
  - provenance (established arguments only);
  - category requirements on **authoritative facts**;
  - invariants;
  - idempotency;
  - the version-checked commit;
  - REVIEW for the abstain category.
- **The intent policy applies to the model path only.** A structured value is the caller's explicit statement; there is nothing to interpret. CLARIFY therefore arises only on the model path, from intent codes; it is unchanged.

## Structured input states the request, not the facts

The field is minted on the caller's channel as `request.reason`. It selects *which rule must hold*; it establishes nothing about the world:
- `reason: DAMAGED_ITEM` with no carrier report → REVIEW (`UNESTABLISHED_REQUIREMENT`);
- the same with the customer's `claims.damaged: true` → still REVIEW (claims are PROPOSING);
- `reason: NEVER_ARRIVED` where the carrier reports "delivered" → REFUSE.

## Compile-time checks (reject before anything runs)

- `field` must be a request fact. The input schema must declare it as a string `enum` **exactly equal** to the mapped values, so unknown categories are rejected by input validation, before any read or effect.
- Every mapped value names a declared category.
- `field` mode: the field must be `required`.
- Structured modes: one effect; established arguments with exactly one source; bounded arguments with a `default`.
- An optional `fromRequest` lets a caller supply a bounded argument (e.g. `amountCents`). It is still bounded by the invariants.
- `model` and `hybrid` contracts must have `spec.model`. The engine refuses to start without a model adapter.

## Tests (`tests/adversarial/routing.test.ts`, 13; plus 26 conformance scenarios)

- **No inference.** On structured requests the model adapter throws if called:
  - hybrid with a valid reason;
  - hybrid with a reason plus an injection-laden message;
  - a field-only contract with no model section at all.
  The full **26-scenario conformance suite passes on the structured path with zero model calls**.
- **Validation before effects:** an unknown reason, or neither reason nor message → `SCHEMA_INVALID` with no tool read.
- **All checks still apply:** structured categories assert no facts; ownership; tenancy; the cap; the balance; the window; abstain → REVIEW; idempotent duplicate; key reuse → `REPLAY_DETECTED`; the exhaustive $80+$80 schedule exploration on a field-only contract.
- **The gate guard:** a field-sourced proposal with a category other than the established field's → refused.
- **Equivalence** (property, 250 runs): for any order, category, amount and claims, a structured request and a model request proposing the same category and amount give the same outcome, code and amount.
- **Hybrid plus intent policy:** a structured reason skips the model and confirmations; free text alone still goes through the policy and can CLARIFY.
- **Mutations caught:** routing that ignores the field; a gate without the re-derivation; a dropped `fromRequest`.

## Benchmark (dev-v2, 200 cases, Qwen 1.5B on the model path; same reference for all)

| Path | Traffic | Model calls | Agreement with reference | Legit done (/74) | Unwanted | Contract violations | Latency p50 / p95 |
|---|---|---|---|---|---|---|---|
| **Deterministic** | every request carries a structured reason | **0** | 95.0% | **74** | **0** | 0 | **0.18 / 0.37 ms** |
| Model-assisted | free text only | 200 | 71.5% | 55 | 22 | 0 | 726 / 1180 ms |
| **Hybrid** | 50% structured, 50% free text | 100 | 84.5% | 63 | 10 | 0 | field 1.4 / 9.6 ms; model 719 / 1289 ms |

- **Structured requests are about 4,000× faster** and, given the caller's true reason, complete every legitimate refund with no unwanted ones. That is expected: the caller states the category, as in the original service. Hybrid traffic gets the benefit in proportion to its structured share.
- **The deterministic path's 5% disagreement is entirely one case.** It is `ord_big` ($900, above the $500 cap) with reason DAMAGED or OTHER (10 requests). The original code refuses over-limit orders first; the gate evaluates the category's requirements and the abstain rule before invariants, so it returns REVIEW. Nothing executes either way.
  - This is a **check-precedence difference**: a human may be asked to review something the cap would refuse.
  - Option (not applied, changes gate behaviour): evaluate invariants that can be decided without the category before the category's requirements.
- The model-path numbers here use the main contract *without* the intent policy, hence 22 unwanted. The intent policy and CLARIFY results are in `intent-classification.md` and `clarify.md`.
