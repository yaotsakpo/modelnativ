/** Load an app and build the review of one of its operations (used by `modelnativ review` and tests). */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import YAML from "yaml";
import { buildReview, linkedTests, reviewFingerprint, type Review } from "@modelnativ/analyzer-typescript";
import { compileContract, expandShorthand, explainShorthand, isConcise } from "@modelnativ/contract-compiler";
import { DEFAULT_DISPATCH, DEFAULT_OUTBOX_LEASE_MS, MemorySecretStore } from "@modelnativ/effect-executor";
import { CryptoRandom, IDEMPOTENCY_DEFAULTS, NO_FAULTS, TRANSIENT_CODES, freeScheduler, loadAppConfig, systemClock } from "@modelnativ/runtime";

/** The fingerprint an observed manifest of this operation must carry to count as evidence. */
export async function appFingerprint(appDir: string, op: string): Promise<string> {
  return (await reviewApp(appDir, op)).json.fingerprint as string;
}

export async function reviewApp(appDir: string, op: string): Promise<Review> {
  const { config, dir } = await loadAppConfig(appDir);
  let raw: Record<string, any> | undefined;
  for (const c of config.contracts) {
    const doc = YAML.parse(readFileSync(resolve(dir, c), "utf8"));
    if (doc?.metadata?.name === op) raw = doc;
  }
  if (!raw) throw new Error(`operation ${op} is not in ${dir}/modelnativ.config.ts (contracts: ${config.contracts.join(", ")})`);
  // Tools and adapters are built against an empty in-memory database: only their metadata is read.
  const db = new Sqlite(":memory:");
  const env = { clock: systemClock, random: new CryptoRandom(), scheduler: freeScheduler, faults: NO_FAULTS };
  const ctx = { db, env, secrets: new MemorySecretStore({}) };
  config.setup?.(ctx);
  const observedPath = join(dir, "review", `${op}.observed.json`);
  let root = dir;
  while (root !== dirname(root) && !existsSync(join(root, "tests"))) root = dirname(root);
  return buildReview({
    contract: expandShorthand(raw),
    hash: compileContract(raw).hash,
    concise: isConcise(raw),
    explain: explainShorthand(raw),
    tools: config.tools(ctx) as never,
    adapters: config.adapters(ctx) as never,
    destinations: (config.destinations?.(ctx) ?? []) as never,
    observed: existsSync(observedPath) ? JSON.parse(readFileSync(observedPath, "utf8")) : null,
    runtime: { settleDefault: "release", retentionMs: IDEMPOTENCY_DEFAULTS.retentionMs, leaseMs: IDEMPOTENCY_DEFAULTS.leaseMs, waitMs: IDEMPOTENCY_DEFAULTS.waitMs, maxWaiters: IDEMPOTENCY_DEFAULTS.maxWaiters, outbox: { maxAttempts: DEFAULT_DISPATCH.maxAttempts, baseMs: DEFAULT_DISPATCH.baseMs, maxMs: DEFAULT_DISPATCH.maxMs, leaseMs: DEFAULT_OUTBOX_LEASE_MS } },
    tests: existsSync(join(root, "tests")) ? linkedTests(root, dir, op) : [],
    transient: [...TRANSIENT_CODES],
  });
}
