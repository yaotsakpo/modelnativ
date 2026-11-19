/**
 * Generate the observed effect manifest of each migrated operation (concise contract + primitives)
 * by running its differential test cases with every tool and adapter observed.
 *   npx tsx bench/review/observe.ts
 * Writes <appDir>/review/<operation>.observed.json, which `modelnativ review` shows as evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withObservation, type AppConfig } from "@modelnativ/runtime";
import { appFingerprint } from "../../packages/cli/src/review-app.ts";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import refundC from "../../examples/refund-original/modelnativ/c/modelnativ.config.ts";
import subC from "../../examples/subscription-original/modelnativ/c/modelnativ.config.ts";
import * as loyalty from "../../tests/differential/loyalty.lib.ts";
import * as refund from "../../tests/differential/refund.lib.ts";
import * as sub from "../../tests/differential/subscription.lib.ts";

export type Lib<C> = { cases: () => C[]; runMigrated: (c: C, config: AppConfig, dir: string) => Promise<unknown> };
export async function observe<C>(op: string, config: AppConfig, dir: string, lib: Lib<C>, source: string) {
  const o = withObservation(config, source);
  o.manifest.operation = op;
  o.manifest.fingerprint = await appFingerprint(dir, op);
  for (const c of lib.cases()) {
    await lib.runMigrated(c, o.config, dir);
    o.countExecution();
  }
  mkdirSync(join(dir, "review"), { recursive: true });
  writeFileSync(join(dir, "review", `${op}.observed.json`), JSON.stringify(o.manifest, null, 1) + "\n");
  console.log(`${op}: ${o.manifest.executions} executions, effects ${JSON.stringify(Object.fromEntries(Object.entries(o.manifest.effects).map(([k, v]) => [k, { applied: v.applied, refused: v.refused, outbox: v.outbox }])))}`);
}
if (process.argv[1]?.endsWith("observe.ts")) {
await observe("loyalty.redeem", loyaltyC, join(loyalty.LOYALTY_ROOT, "c"), loyalty as Lib<loyalty.Case>, "tests/differential/loyalty.lib.ts cases() (2,574)");
await observe("refund.request", refundC, join(refund.REFUND_ROOT, "c"), refund as unknown as Lib<refund.Case>, "tests/differential/refund.lib.ts cases() (870)");
await observe("plan.change", subC, join(sub.SUB_ROOT, "c"), { cases: () => sub.cases(), runMigrated: sub.runMigrated }, "tests/differential/subscription.lib.ts cases(2500)");
}
