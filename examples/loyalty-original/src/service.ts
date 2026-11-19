import type Database from "better-sqlite3";

export type Member = { id: string; tenantId: string };
export type RedeemRequest = { rewardId: string; quantity: number; note?: string };
export type RedeemResult =
  | { status: "redeemed"; redemptionId: string; pointsSpent: number }
  | { status: "rejected"; reason: "inactive" | "insufficient_points" | "out_of_stock" | "tier_required" | "daily_limit" | "not_found" };

const DAILY_LIMIT = 3;
const TIER_RANK: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };

export class RedemptionService {
  constructor(private db: Database.Database, private now: () => number, private fulfillmentUrl: string) {}

  redeem(member: Member, req: RedeemRequest): RedeemResult {
    const tx = this.db.transaction((): RedeemResult => {
      const acct = this.db.prepare("SELECT points, tier, status FROM loyalty_accounts WHERE member_id = ? AND tenant_id = ?").get(member.id, member.tenantId) as
        | { points: number; tier: string; status: string }
        | undefined;
      if (!acct) return { status: "rejected", reason: "not_found" };
      if (acct.status !== "active") return { status: "rejected", reason: "inactive" };
      const reward = this.db.prepare("SELECT cost, stock, min_tier FROM rewards WHERE id = ? AND tenant_id = ?").get(req.rewardId, member.tenantId) as
        | { cost: number; stock: number; min_tier: string }
        | undefined;
      if (!reward) return { status: "rejected", reason: "not_found" };
      if (TIER_RANK[acct.tier]! < TIER_RANK[reward.min_tier]!) return { status: "rejected", reason: "tier_required" };
      if (reward.stock < req.quantity) return { status: "rejected", reason: "out_of_stock" };
      const total = reward.cost * req.quantity;
      if (acct.points < total) return { status: "rejected", reason: "insufficient_points" };
      const today = (this.db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE member_id = ? AND created_at > ?").get(member.id, this.now() - 86_400_000) as { n: number }).n;
      if (today >= DAILY_LIMIT) return { status: "rejected", reason: "daily_limit" };
      this.db.prepare("UPDATE loyalty_accounts SET points = points - ? WHERE member_id = ?").run(total, member.id);
      this.db.prepare("UPDATE rewards SET stock = stock - ? WHERE id = ?").run(req.quantity, req.rewardId);
      const id = `rd_${this.now()}`;
      this.db.prepare("INSERT INTO redemptions (id, member_id, reward_id, quantity, points, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, member.id, req.rewardId, req.quantity, total, this.now());
      return { status: "redeemed", redemptionId: id, pointsSpent: total };
    });
    const result = tx.immediate();
    if (result.status === "redeemed") void fetch(this.fulfillmentUrl, { method: "POST", body: JSON.stringify({ redemptionId: result.redemptionId }) });
    return result;
  }
}
