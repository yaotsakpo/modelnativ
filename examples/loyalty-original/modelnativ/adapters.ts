// Completed from generated/adapters.scaffold.ts.txt. Reads are tenant-scoped tools (facts minted on
// their own channel); the writes run inside the commit transaction, each guarded.
import type Database from "better-sqlite3";
import { EffectRefusal, type Destination, type EffectAdapter } from "@modelnativ/effect-executor";
import type { ReadTool } from "@modelnativ/runtime";
import { LOYALTY_POLICY } from "./policy.ts";

const TIER_RANK: Record<string, number> = { bronze: 1, silver: 2, gold: 3 }; // service.ts:9
const DAY = 86_400_000;

export function tools(db: Database.Database, now: () => number): ReadTool[] {
  return [
    { name: "policy.get", async read() { return { ...LOYALTY_POLICY }; } },
    {
      name: "accounts.mine",
      async read(a) {
        const r = db.prepare("SELECT points, tier, status FROM loyalty_accounts WHERE member_id = ? AND tenant_id = ?").get(a.member, a.tenant) as { points: number; tier: string; status: string } | undefined;
        if (!r) return null;
        return { "acct.memberId": a.member, "acct.tenantId": a.tenant, "acct.points": r.points, "acct.status": r.status, "acct.tierRank": TIER_RANK[r.tier] ?? 0 };
      },
    },
    {
      name: "rewards.get",
      async read(a) {
        const r = db.prepare("SELECT cost, stock, min_tier FROM rewards WHERE id = ? AND tenant_id = ?").get(a.rewardId, a.tenant) as { cost: number; stock: number; min_tier: string } | undefined;
        if (!r) return null;
        return { "reward.id": a.rewardId, "reward.stock": r.stock, "reward.minTierRank": TIER_RANK[r.min_tier] ?? 99, "reward.totalCost": r.cost * Number(a.quantity) };
      },
    },
    {
      name: "redemptions.today",
      async read(a) {
        const r = db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?").get(a.member, now() - DAY) as { n: number };
        return { "today.count": r.n };
      },
    },
  ];
}

export const redeemAdapter: EffectAdapter = {
  tool: "loyalty.redeem.apply",
  apply(db, args, binding, { effectId, now }) {
    const points = Number(args.points), quantity = Number(args.quantity);
    // Re-check what the decision relied on, against CURRENT state, and guard every write.
    const today = (db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?").get(args.memberId, now - DAY) as { n: number }).n;
    if (today >= Number(args.dailyLimit)) throw new EffectRefusal("INVARIANT_VIOLATION", "daily limit reached meanwhile", "daily_limit");
    const p = db.prepare("UPDATE loyalty_accounts SET points = points - ? WHERE member_id = ? AND tenant_id = ? AND status = 'active' AND points >= ?").run(points, args.memberId, binding.tenant, points);
    if (p.changes !== 1) throw new EffectRefusal("INVARIANT_VIOLATION", "points changed meanwhile", "insufficient_points");
    const s = db.prepare("UPDATE rewards SET stock = stock - ? WHERE id = ? AND tenant_id = ? AND stock >= ?").run(quantity, args.rewardId, binding.tenant, quantity);
    if (s.changes !== 1) throw new EffectRefusal("INVARIANT_VIOLATION", "stock changed meanwhile", "out_of_stock");
    const id = effectId.replace(/^eff_/, "rd_");
    db.prepare("INSERT INTO redemptions (id, member_id, reward_id, quantity, points, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, args.memberId, args.rewardId, quantity, points, now);
    return { result: { status: "redeemed", redemptionId: id, pointsSpent: points }, outbox: [{ destination: "fulfillment", payload: { redemptionId: id } }] };
  },
};

/** service.ts:39 `fetch(fulfillmentUrl, …)`, now sent from the outbox after commit (at-least-once). */
export function fulfillment(url: string, doFetch: typeof fetch = fetch): Destination {
  return {
    name: "fulfillment",
    secrets: [],
    async send(payload, { idempotencyKey }) {
      const r = await doFetch(url, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(payload) });
      if (!r.ok) throw Object.assign(new Error(`fulfillment ${r.status}`), { retryable: r.status >= 500 });
      return { externalId: String(payload.redemptionId) };
    },
  };
}
