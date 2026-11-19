/**
 * The original's injectable config (approvalThresholdCents, maxPlanChangesPerPeriod) is preserved:
 * for non-default configs, A, B and C match the original configured the same way.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeApp as makeA } from "../../examples/subscription-original/modelnativ/a/modelnativ.config.ts";
import { makeApp as makeB } from "../../examples/subscription-original/modelnativ/b/modelnativ.config.ts";
import { makeApp as makeC } from "../../examples/subscription-original/modelnativ/c/modelnativ.config.ts";
import { differential } from "./harness.ts";
import { SUB_ROOT, cases, runMigrated, runOriginal } from "./subscription.lib.ts";

const CONFIGS = [
  { approvalThresholdCents: 5_000, maxPlanChangesPerPeriod: 1 },
  { approvalThresholdCents: 100_000, maxPlanChangesPerPeriod: 3 },
];
const APPROACHES = [["A", makeA, "a"], ["B", makeB, "b"], ["C", makeC, "c"]] as const;

describe("subscription: non-default configuration is honoured", () => {
  for (const cfg of CONFIGS)
    for (const [name, make, dir] of APPROACHES)
      it(`${name} with ${JSON.stringify(cfg)}`, { timeout: 1_200_000 }, async () => {
        const all = cases(600);
        const rep = await differential(all, (c) => runOriginal(c, cfg), (c) => runMigrated(c, make(cfg), join(SUB_ROOT, dir)));
        if (rep.mismatches.length) console.log(JSON.stringify(rep.mismatches.slice(0, 2).map((m) => ({ c: m.case, o: { ...m.original, state: undefined }, m: { ...m.migrated, state: undefined } }))));
        const mix: Record<string, number> = {};
        for (const c of all) { const o = await runOriginal(c, cfg); mix[o.reason ?? o.outcome] = (mix[o.reason ?? o.outcome] ?? 0) + 1; }
        console.log(`subscription ${name} ${JSON.stringify(cfg)}: ${rep.matches}/${rep.total}; mix ${JSON.stringify(mix)}`);
        // The config must actually change outcomes relative to the default (not vacuous).
        expect((mix.pending_approval ?? 0) + (mix.plan_change_limit_reached ?? 0)).toBeGreaterThan(20);
        expect(rep.mismatches).toEqual([]);
      });
});
