import { join } from "node:path";
import { describe, expect, it } from "vitest";
import configA from "../../examples/subscription-original/modelnativ/a/modelnativ.config.ts";
import { differential } from "./harness.ts";
import { SUB_ROOT, cases, runMigrated, runOriginal } from "./subscription.lib.ts";

describe("differential: subscription plan change (independently written original)", () => {
  it("approach A matches the original", { timeout: 1_200_000 }, async () => {
    const all = cases();
    const rep = await differential(all, runOriginal, (c) => runMigrated(c, configA, join(SUB_ROOT, "a")));
    const mix: Record<string, number> = {};
    for (const m of rep.mismatches.slice(0, 0)) void m;
    if (rep.mismatches.length) {
      const by: Record<string, number> = {};
      for (const m of rep.mismatches) { const k = `${m.original.outcome}:${m.original.reason} -> ${m.migrated.outcome}:${m.migrated.reason} [${m.fields}]`; by[k] = (by[k] ?? 0) + 1; }
      console.log(JSON.stringify(by, null, 1));
      console.log(JSON.stringify(rep.mismatches.slice(0, 2).map((m) => ({ c: m.case, o: m.original, m: m.migrated })), null, 1).slice(0, 3000));
    }
    console.log(`subscription A: ${rep.matches}/${rep.total}`);
    // Not vacuous: every rejection reason, both success statuses, and multi-failure cases occur.
    for (const c of all) {
      const o = await runOriginal(c);
      mix[o.reason ?? o.outcome] = (mix[o.reason ?? o.outcome] ?? 0) + 1;
    }
    console.log("outcome mix", JSON.stringify(mix));
    expect(Object.keys(mix).length).toBeGreaterThanOrEqual(13);
    expect(mix.changed).toBeGreaterThan(30);
    expect(mix.pending_approval).toBeGreaterThan(10);
    void mix;
    expect(rep.mismatches).toEqual([]);
  });
});
