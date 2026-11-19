# Canonical JSON: domain, RFC 8785 status, and hash-migration policy

`canonicalJson` (`packages/contract-schema/src/index.ts`) is the single serialisation behind every security-relevant hash and comparison. Before the optimisation review there were four byte-identical copies (compiler, engine, mock adapter, replay). Consolidating them changed no output: the code is the same algorithm. `packages/contract-schema/test/canonical.test.ts` now pins the output.

## Supported input domain (the guarantee)

JSON values only:
- `null`, booleans, finite numbers, and strings without lone surrogates;
- arrays without holes;
- plain objects whose values are themselves in the domain.

**Within the domain, the output is RFC 8785 (JCS):**

| JCS rule | Our behaviour |
|---|---|
| Keys sorted by UTF-16 code units | JS default `sort()` on strings compares UTF-16 code units. |
| Strings serialised as ECMAScript `JSON.stringify` does | Identical. |
| Numbers serialised as ECMAScript `Number.prototype.toString` does | Identical. `-0` → `0`. |
| No whitespace | Identical. |

The tests check the RFC's §3.2.2 sample, its §3.2.3 sorting example and its Appendix B number sample. A 2000-run property test checks key-order independence and stability under a JSON round trip.

## Outside the domain: pinned, not guaranteed

| Input | Output now | `JSON.stringify` | JCS |
|---|---|---|---|
| `{a: undefined}` | `{"a":undefined}` (invalid JSON) | `{}` | n/a (not JSON) |
| `[undefined]` | `[]`: **collides with `[]`** (`Array.join` renders `undefined` as empty) | `[null]` | n/a |
| array holes `[1,,3]` | `[1,,3]` (invalid JSON) | `[1,null,3]` | n/a |
| `NaN`, `±Infinity` | `null` | `null` | must error |
| `Date` | `{}` | ISO string | n/a |
| `Map`, `Set`, class instances | `{}` / own enumerable props | same, or `toJSON` | n/a |
| objects with `toJSON` | `toJSON` ignored | `toJSON` used | n/a |
| lone surrogate | `"\ud800"` escaped | same | input must be I-JSON (error) |
| `BigInt`, cycles | throws | throws | n/a |

## Caller analysis: can any caller hand it an out-of-domain value today?

| Caller | Hash or comparison | Source of the value | Exposure |
|---|---|---|---|
| contract compiler | contract hash | `YAML.parse` (yaml 2, YAML 1.2 core schema: no timestamps or `undefined`) | **None.** |
| engine | idempotency `requestHash` | HTTP: `express.json` output, always in domain. Embedded: the host's mapped object, which may contain `undefined` keys | **Embedded only.** `{message, claims: undefined}` hashes differently from `{message}`. Effect: a retry that differs only by an `undefined` key gets `REPLAY_DETECTED` (fails closed, never a duplicate effect). |
| model-adapter `hashModelInput` | replay lookup key | observations come from operative PSAP values; the engine never mints `undefined`. A tool returning a `Date` would hash as `{}` | **Low.** Two different Dates would collide in the replay lookup, and replay would then serve a decision recorded for a different input. Fails only in replay, never in enforcement. |
| `replayTrace` | trace vs replay equality | in-memory traces can hold `undefined` values (e.g. `shipment.damaged: undefined` from a tool); traces loaded from disk have them dropped | **Low.** Today both sides of each comparison come from the same origin, so they agree. A future comparison of an in-memory trace with a disk trace would report a false divergence (fails loud). |

The `[undefined]` / `[]` collision was found by the pinning tests during this review. No caller can produce an `undefined` array element today: request bodies are validated JSON, and tool results are minted per field. It is still the strongest argument for `canonicalJsonStrict`.

**Conclusion.** No caller can produce a *wrong authorization* through canonicalisation. The two real exposures fail closed (an idempotency conflict) or fail loud (a replay divergence). Two are worth fixing deliberately.

## Recommended migration (NOT applied; needs your approval)

1. Add `canonicalJsonStrict`, which **throws** on anything outside the domain. Same output inside it.
2. Normalise at the boundaries instead of changing the hash function:
   - SDK `execute`/`bind`: `JSON.parse(JSON.stringify(input))` before validation, so embedded inputs equal HTTP inputs;
   - tool results: reject non-JSON values at mint time, so a `Date` must be converted by the tool explicitly.
3. Switch callers to the strict variant one at a time. For each, the golden vectors prove that in-domain output is byte-identical, so **no stored hash changes**: contract hashes, request hashes in `mn_effects` and trace hashes stay valid.
4. If in-domain output ever has to change (for example, adopting a JCS library with different number formatting), that is a **hash migration**:
   - version the scheme (`h1:` prefix);
   - dual-read old and new hashes for idempotency lookups for at least the idempotency retention window;
   - re-pin contract hashes in audit with a version marker;
   - mark old traces as replayable only with the old scheme.
