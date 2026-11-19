import { describe, expect, it } from "vitest";
import config from "../../examples/refund-original/modelnativ/modelnativ.config.ts";
import { differential } from "./harness.ts";
import { REFUND_ROOT, cases, never, runMigrated, runOriginal } from "./refund.lib.ts";
describe("differential: refund request, structured path (no model)", () => {
  it("matches the original on outcome, reason, amount and state, including error precedence", { timeout: 300_000 }, async () => {
    const all = cases();
    const rep = await differential(all, runOriginal, (c) => runMigrated(c, config, REFUND_ROOT));
    if (rep.mismatches.length) console.log(JSON.stringify(rep.byField), JSON.stringify(rep.mismatches.slice(0, 3).map((m) => ({ c: { ...m.case.order, reason: m.case.reason }, o: { ...m.original, state: undefined }, m: { ...m.migrated, state: undefined } }))));
    const mix: Record<string, number> = {};
    for (const c of all) {
      const o = await runOriginal(c);
      mix[o.reason ?? o.outcome] = (mix[o.reason ?? o.outcome] ?? 0) + 1;
    }
    console.log(`refund differential: ${rep.matches}/${rep.total} identical; outcome mix ${JSON.stringify(mix)}`);
    expect(never.calls).toBe(0);
    expect(mix.over_limit).toBeGreaterThan(50); // the $900 precedence case, many times
    expect(rep.mismatches).toEqual([]);
  });
});
