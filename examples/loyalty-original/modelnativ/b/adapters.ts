// Approach B: same explicit contract as A; adapters built from primitives.
import type Database from "better-sqlite3";
import { configFacts, sqlEffect, sqlRead } from "@modelnativ/runtime";
import { fulfillment } from "../adapters.ts";
import { LOYALTY_POLICY } from "../policy.ts";

const TIER: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };
const DAY = 86_400_000;

export const tools = (db: Database.Database, now: () => number) => [
  configFacts("policy.get", LOYALTY_POLICY),
  sqlRead(db, {
    name: "accounts.mine",
    sql: "SELECT member_id, tenant_id, points, tier, status FROM loyalty_accounts WHERE member_id = ? AND tenant_id = ?",
    params: ["member", "tenant"],
    tenantParam: "tenant",
    facts: { "acct.memberId": "member_id", "acct.tenantId": "tenant_id", "acct.points": "points", "acct.status": "status", "acct.tierRank": (r) => TIER[r.tier as string] ?? 0 },
  }),
  sqlRead(db, {
    name: "rewards.get",
    sql: "SELECT id, stock, min_tier, cost FROM rewards WHERE id = ? AND tenant_id = ?",
    params: ["rewardId", "tenant"],
    tenantParam: "tenant",
    facts: { "reward.id": "id", "reward.stock": "stock", "reward.minTierRank": (r) => TIER[r.min_tier as string] ?? 99, "reward.totalCost": (r, a) => Number(r.cost) * Number(a.quantity) },
  }),
  sqlRead(db, { name: "redemptions.today", sql: "SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?", params: ["member", () => now() - DAY], facts: { "today.count": "n" } }),
];

export const redeemAdapter = sqlEffect({
  tool: "loyalty.redeem.apply",
  steps: [
    { check: "SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?", params: (c) => [c.args.memberId, c.now - DAY], assert: (r, c) => Number(r?.n) < Number(c.args.dailyLimit), refuse: { code: "INVARIANT_VIOLATION", reason: "daily_limit" } },
    { write: "UPDATE loyalty_accounts SET points = points - ? WHERE member_id = ? AND tenant_id = ? AND status = 'active' AND points >= ?", params: (c) => [c.args.points, c.args.memberId, c.binding.tenant, c.args.points], refuse: { code: "INVARIANT_VIOLATION", reason: "insufficient_points" } },
    { write: "UPDATE rewards SET stock = stock - ? WHERE id = ? AND tenant_id = ? AND stock >= ?", params: (c) => [c.args.quantity, c.args.rewardId, c.binding.tenant, c.args.quantity], refuse: { code: "INVARIANT_VIOLATION", reason: "out_of_stock" } },
    { insert: "INSERT INTO redemptions (id, member_id, reward_id, quantity, points, created_at) VALUES (?, ?, ?, ?, ?, ?)", params: (c) => [c.effectId.replace(/^eff_/, "rd_"), c.args.memberId, c.args.rewardId, c.args.quantity, c.args.points, c.now] },
  ],
  result: (c) => ({ status: "redeemed", redemptionId: c.effectId.replace(/^eff_/, "rd_"), pointsSpent: Number(c.args.points) }),
  outbox: (c) => [{ destination: "fulfillment", payload: { redemptionId: c.effectId.replace(/^eff_/, "rd_") } }],
});

export { fulfillment };
