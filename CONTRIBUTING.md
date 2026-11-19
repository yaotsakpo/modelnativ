# Contributing to Modelnativ

Thanks for looking. Modelnativ is a **developer preview**. Its value rests on three things holding:

- **correctness:** behaviour stays equal to the stated reference, or the difference is documented;
- **determinism:** every test reproduces exactly;
- **honest claims:** nothing is asserted that the evidence does not show.

Contributions that strengthen those are the most welcome.

## Set up

```bash
corepack enable          # pnpm 9 (pinned in package.json)
pnpm install             # Node 20 or 22
pnpm typecheck
pnpm test                # fast, deterministic suite
pnpm test:slow           # differentials, exhaustive concurrency, multi-process (minutes)
```

The local-model runtime (`node-llama-cpp`) is **not installed by default**. Nothing in the fast or slow suite needs it. To experiment with free-text decisions, run `pnpm add -w node-llama-cpp@^3 && pnpm mn model pull qwen2.5-1.5b-instruct`.

## Where things are

| Path | What |
|---|---|
| `packages/contract-schema`, `packages/contract-compiler` | Contract types, JSON Schema, concise-to-explicit expansion, compiler |
| `packages/gate` | Evidence and authorization gate. Includes the vendored PSAP resolver (`psap-authority.ts`), which must stay **byte-identical**; a test pins its hash. |
| `packages/runtime` | The kernel (`engine.ts`), app assembly, primitives (`sqlRead`, `sqlEffect`, `configFacts`), the HTTP server, replay, the deterministic environment |
| `packages/effect-executor` | Commit transaction, idempotency claims, outbox dispatcher |
| `packages/core` | Embedded SDK (`createModelnativ`, `bind`, `classify`) |
| `packages/cli` | `modelnativ` command: compile, review, lint, serve, replay |
| `packages/analyzer-typescript` | `review`, `lint` and migration-extraction helpers |
| `examples/subscription-original` | **Primary example:** the conventional service (`src/`, `test/`) and the Modelnativ implementation (`modelnativ/`). See its README. |
| `examples/loyalty-original`, `examples/refund-*` | Secondary examples |
| `tests/` | Framework tests (`adversarial`, `integration`, `concurrency`, `replay`, `conformance`), differentials (`differential`), shared example tests (`shared`) |
| `docs/` | User documentation |

## Ground rules

1. **Every behaviour change comes with a test that fails without it.** For safety checks (gate rules, idempotency, outbox, fencing), also show that disabling the check makes a test fail. Many existing tests follow this pattern.
2. **Tests are deterministic.**
   - Use `testEnv()` (virtual clock, seeded ids), and `ControlledScheduler` / `exploreSchedules` for concurrency.
   - Never sleep on the real clock.
   - Real sockets or processes go only into tests that need them, with explicit timeouts. Put slow tests in the slow list in `vitest.config.ts`.
3. **Contracts never gain hidden inference.** The concise form may remove repetition. It may not invent rules or permissions. Every default must appear in `modelnativ compile --explain` and in `docs/concise-contracts.md`.
4. **Equivalence claims are measured.** If you change an example, run `pnpm test:slow` (its differential). If a difference from the conventional implementation is intentional, add it to the example's README table, saying how it is verified, or "not tested".
5. **No new infrastructure without a measured need:** no Redis, broker or orchestrator. SQLite plus the transactional outbox is the baseline.
6. **Keep the review honest.** Anything `modelnativ review` labels `verified` must come from executable definitions or recorded runs. Developer descriptions are always shown as `UNVERIFIED`.

## Pull requests

- Keep them small and focused: one change, with its tests and docs.
- CI runs the fast suite on Ubuntu and macOS with Node 20 and 22, plus an install without optional dependencies. Add the `run-slow` label to also run the slow suite.
- In the description, say what you verified and what you did not.
- Contributions are accepted under the project license (Apache-2.0, inbound = outbound).

## Good first contributions

- Install and test reports for Linux distributions and Windows.
- More differential cases or properties for an example.
- A new example operation in the same shape: conventional, Modelnativ, shared tests.
- Clearer error messages from the compiler or from `modelnativ review`.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
