# Contracts as the documentation source (design; generator not built)

The contract is the single authoritative source. Documentation is **generated** from the compiled contract, so it cannot drift: the compiler validates every example request against the input schema, and rules are documented by the same expressions the gate evaluates.

## What the schema already carries

| Doc element | Contract source |
|---|---|
| Operation name, version, summary, description | `metadata.name`, `.version`, `.summary`, `.description` |
| Inputs | `spec.input` (JSON Schema, with its `description` fields) |
| Who may call | `spec.principal.scopes`, `spec.tenancy`, `spec.policy.authorization` |
| What the model decides | `spec.model.role`, `spec.decision.categories[*].description` |
| What the model may see | `spec.model.sees` (data-minimisation statement) |
| Business rules | `requires` / `authorization` / `invariants`. Each entry is an expression or `{rule, description}`; the description is shown to humans, the rule is what runs. |
| Which facts are trusted, and from where | `spec.facts` + `spec.authority` (a table: fact → channel → grant). Customer `claims` are listed as *not* authoritative. |
| Effects and their arguments | `spec.effects` (provenance per argument: established-from vs bounded-by) |
| Refusal conditions | Derived: each rule → its refusal code (`authorization` → CAPABILITY_MISSING, `invariants` / `requires` false → INVARIANT_VIOLATION, unestablished → REVIEW or UNVERIFIABLE_PRECONDITION per category), plus the kernel's fixed codes |
| Examples (valid, review, rejected) | `spec.examples[*]`: request, principal, expected outcome and code |
| Version and integrity | the compiled contract hash |

**Added in this review** (additive; existing contracts are unchanged): `metadata.summary`, `{rule, description}` rule objects, and `spec.examples` with compile-time validation.

## Later: `modelnativ docs generate | serve`

- **Business documentation** (Markdown/HTML) rendered from the compiled IR, including the defaults the compiler expands. If code-reduction R4 lands, the docs must show the expanded contract, never the shorthand.
- **OpenAPI 3.1** for the HTTP surface only, with **no new contract fields needed**:
  - `POST /v1/<operation>`;
  - request body = `spec.input`;
  - bearer security, with the scopes listed;
  - the `Idempotency-Key` header (required);
  - responses from the engine's fixed status mapping (201 ALLOW, 200 duplicate, 202 REVIEW, 400/401/403/409/422/429/503 with a refusal-code enum).
  Modelnativ-specific semantics (authority, provenance, categories) go into an `x-modelnativ` extension that points to the business documentation, rather than being forced into OpenAPI.
- **Examples as tests.** `modelnativ test --examples` can run each example through the kernel with recorded or stubbed facts, so documentation examples are verified on every build. That needs a `facts` stub per example; leave it for when the generator is built.
