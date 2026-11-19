import { defineConfig } from "vitest/config";

/**
 * `pnpm test`       fast, deterministic suite (the default; run on every change)
 * `pnpm test:slow`  differentials against the conventional implementations, exhaustive
 *                   multi-variant concurrency, 1,000-request load tests, two-OS-process tests
 * `pnpm test:all`   both
 */
const ALL = ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts", "examples/*/test/**/*.test.ts"];
const SLOW = [
  "tests/differential/*.diff.test.ts",
  "tests/differential/approaches.test.ts",
  "tests/differential/subscription.config.test.ts",
  "tests/differential/approaches.concurrency.test.ts",
  "tests/concurrency/**/*.test.ts",
  "tests/integration/idempotency.test.ts",
];
const mode = process.env.MN_TEST ?? "fast";

export default defineConfig({
  test: mode === "slow" ? { include: SLOW } : mode === "all" ? { include: ALL } : { include: ALL, exclude: [...SLOW, "**/node_modules/**"] },
});
