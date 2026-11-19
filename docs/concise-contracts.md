# Concise contracts (`kind: ConciseOperation`)

A concise contract is a shorter way to write an operation contract. The compiler **expands it into an explicit contract (`kind: Operation`) before anything else happens**. The expanded document is what is validated, hashed, run, audited and documented, so the concise form cannot change semantics: it can only produce an explicit contract that you could have written by hand.

Concise is the **recommended form for new operations**. Explicit contracts (`kind: Operation`) remain fully supported, are never rewritten, and are what every concise contract becomes.

## Activation is explicit

| `kind` | What the compiler does |
|---|---|
| `Operation` | Nothing is added. The document must be complete; a missing required block (e.g. `failure`) is a validation error. Shorthand constructs (`reads`, `claims`, rule maps, string effect args) are rejected by the schema. |
| `ConciseOperation` | Shorthand is expanded and the defaults below are filled in, then the result is validated as `kind: Operation`. |

Nothing else switches shorthand on. In particular, a missing field never does.

## See exactly what you get

```
modelnativ compile --expanded <file>     # the explicit contract, as YAML (this is what is hashed and run)
modelnativ compile --explain <file>      # every default and expansion the compiler applied, one per line
```

`--explain` lists each expansion with the path it wrote, for example:

```
spec.failure                     default  { onUnverifiable: refuse, onModelError: refuse }
spec.facts[1] / spec.authority[1] reads    rewards.get -> facts + grant cap.rewards.get on tool:rewards.get: [reward.*]
spec.decision.categories.REDEEM.requires[2] rule  "reward.stock >= request.quantity": out_of_stock
```

## Every default and expansion

Each row gives what you write in a concise contract, what the compiler produces, and how to override it.

| You write (concise) | Expanded to (explicit) | To override |
|---|---|---|
| `principal: { scopes: [...] }` | `principal: { required: true, scopes: [...] }` | Write `required: false`. |
| `concurrency: { key: request.x }` | `concurrency: { key: request.x, mode: serialized_per_resource, maxQueue: 1000 }` | Write `mode` and/or `maxQueue`. |
| *(no `failure`)* | `failure: { onUnverifiable: refuse, onModelError: refuse }` | Write `failure:` with your values. |
| `reads: { <tool>: { args, provides, establishes } }` | One `spec.facts` entry `{ tool, args, provides }` **and** one `spec.authority` grant `{ id: cap.<tool>, channel: "tool:<tool>", predicates: <establishes> }` per read | Write `spec.facts`/`spec.authority` explicitly instead of `reads` (not both). |
| `establishes` | Required for every read. Authority is never inferred; a read without it is a compile error. | none |
| *(request facts)* | `facts[0] = { tool: request, provides: [request.<p> for every property of spec.input] }` and the grant `cap.request` on `principal` for `request.*` | Use explicit `facts`/`authority`. |
| `claims: [shipment.damaged]` | `facts[0].claims: [shipment.damaged]` (caller claims, PROPOSING, never established) | none |
| Rule `- "expr": code` | `- { rule: "expr", code: code }` | Write the object form. |
| Rule `- "expr": { code, unestablished: review }` | `- { rule: "expr", code, unestablished: { outcome: review } }` | Write the object form (e.g. with `unestablished.code`). |
| *(no `policy.invariants` / `policy.authorization`)* | `[]` | Write them. |
| Effect without `mode` / `idempotency` | `mode: effectful`, `idempotency: required` | Write them. |
| Effect arg `name: some.fact` | `{ type: string, authority: established, from: [some.fact] }` | Use `{ from, type }` or the full object. |
| Effect arg `name: { from: f, type: integer }` | `{ type: integer, authority: established, from: [f] }` | Use the full object (e.g. `authority: bounded`). |

`spec.idempotency` is passed through unchanged; it is never defaulted by the concise form (absent = runtime default). New operations should declare `{ settle: terminal }`.

What concise contracts never do:

- **Infer a business rule or a permission.** Every rule is written, and every grant is written as `establishes`.
- **Pick a decision source.** `decision.source` is written as in an explicit contract.
- **Change the order of rules.** List order is preserved, and with it error precedence.

## Errors

Semantic errors name facts, rules and effects, so they read the same for both forms. Schema errors report a JSON pointer into the *expanded* document. List indices for rules match the concise source.

For blocks that the concise form generates (`facts`, `authority`), the index counts `facts[0]` as the request entry, followed by `reads` in source order. Use `--explain` to map them.

## Example

Concise (`examples/loyalty-original/modelnativ/c/loyalty.redeem.yaml`) next to the explicit contract it expands to (`examples/loyalty-original/modelnativ/loyalty.redeem.yaml`). The test `tests/contracts/concise-vs-explicit.test.ts` checks, for loyalty, refund and subscription, that the expansion equals the hand-written explicit contract. Documentation-only fields (comments, descriptions) are ignored, and so are the grant ids, which the expander names `cap.<tool>`.
