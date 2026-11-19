import { describe, expect, it } from "vitest";
import config from "../../examples/loyalty-original/modelnativ/modelnativ.config.ts";
import { differential } from "./harness.ts";
import { LOYALTY_ROOT, cases, runMigrated, runOriginal } from "./loyalty.lib.ts";
describe("differential: loyalty redemption (deterministic migration)", () => {
  it("matches the original on outcome, reason, amount, state and external calls", { timeout: 1_200_000 }, async () => {
    const all = cases();
    const rep = await differential(all, runOriginal, (c) => runMigrated(c, config, LOYALTY_ROOT));
    if (rep.mismatches.length) console.log(JSON.stringify(rep.byField), JSON.stringify(rep.mismatches.slice(0, 3), null, 1));
    console.log(`loyalty differential: ${rep.matches}/${rep.total} identical`);
    // Not vacuous: a spread of outcomes, and many cases where several checks fail at once.
    const mix: Record<string, number> = {};
    let multi = 0;
    for (const c of all) {
      const o = await runOriginal(c);
      mix[o.reason ?? o.outcome] = (mix[o.reason ?? o.outcome] ?? 0) + 1;
      const failing = [!c.acct || c.acct.tenant !== "t_a", c.acct?.status !== "active", !c.reward || c.reward.tenant !== "t_a", (c.reward?.stock ?? 9) < c.quantity, c.recent >= 3].filter(Boolean).length;
      if (failing >= 2) multi++;
    }
    console.log("outcome mix", JSON.stringify(mix), "cases with >=2 failing checks:", multi);
    expect(mix.ALLOW).toBeGreaterThan(50);
    expect(Object.keys(mix).length).toBe(7); // ALLOW + 6 distinct reasons (both existence checks return "not_found")
    expect(multi).toBeGreaterThan(500);
    expect(rep.total).toBeGreaterThan(1500);
    expect(rep.mismatches).toEqual([]);
  });
});
