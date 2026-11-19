/**
 * Approaches B (primitives) and C (concise contract) against the SAME originals, cases and harness
 * as approach A (loyalty.diff.test.ts, refund.diff.test.ts).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import loyaltyB from "../../examples/loyalty-original/modelnativ/b/modelnativ.config.ts";
import loyaltyC from "../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";
import refundB from "../../examples/refund-original/modelnativ/b/modelnativ.config.ts";
import refundC from "../../examples/refund-original/modelnativ/c/modelnativ.config.ts";
import { differential } from "./harness.ts";
import * as L from "./loyalty.lib.ts";
import * as R from "./refund.lib.ts";
import * as S from "./subscription.lib.ts";
import subB from "../../examples/subscription-original/modelnativ/b/modelnativ.config.ts";
import subC from "../../examples/subscription-original/modelnativ/c/modelnativ.config.ts";

describe("approach B and C: same behaviour as the originals", () => {
  for (const [name, cfg, dir] of [["B (primitives)", loyaltyB, join(L.LOYALTY_ROOT, "b")], ["C (concise)", loyaltyC, join(L.LOYALTY_ROOT, "c")]] as const)
    it(`loyalty ${name}`, { timeout: 1_200_000 }, async () => {
      const rep = await differential(L.cases(), L.runOriginal, (c) => L.runMigrated(c, cfg, dir));
      console.log(`loyalty ${name}: ${rep.matches}/${rep.total}`);
      expect(rep.mismatches).toEqual([]);
    });
  for (const [name, cfg, dir] of [["B (primitives)", refundB, join(R.REFUND_ROOT, "b")], ["C (concise)", refundC, join(R.REFUND_ROOT, "c")]] as const)
    it(`refund ${name}`, { timeout: 1_200_000 }, async () => {
      const rep = await differential(R.cases(), R.runOriginal, (c) => R.runMigrated(c, cfg, dir));
      console.log(`refund ${name}: ${rep.matches}/${rep.total}`);
      expect(rep.mismatches).toEqual([]);
      expect(R.never.calls).toBe(0);
    });
  for (const [name, cfg, dir] of [["B (primitives)", subB, join(S.SUB_ROOT, "b")], ["C (concise)", subC, join(S.SUB_ROOT, "c")]] as const)
    it(`subscription ${name}`, { timeout: 1_200_000 }, async () => {
      const rep = await differential(S.cases(), S.runOriginal, (c) => S.runMigrated(c, cfg, dir));
      console.log(`subscription ${name}: ${rep.matches}/${rep.total}`);
      expect(rep.mismatches).toEqual([]);
    });
});
