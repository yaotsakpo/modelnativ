// Shared by all approaches: deterministic arithmetic and classification, reused from the original.
import { DEFAULT_CONFIG, computeProrationCents, type SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";

const TIER_RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 }; // service.ts:106

/** The original's injectable config (service.ts:61-71) as policy facts; defaults from the original itself. */
export const policyFacts = (cfg: Partial<SubscriptionServiceConfig> = {}) => {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  return { "policy.approvalThresholdCents": c.approvalThresholdCents, "policy.maxPlanChangesPerPeriod": c.maxPlanChangesPerPeriod };
};

export function changeFacts(r: { cur_price: number; cur_tier: string; tgt_price: number; tgt_tier: string; period_start: string; period_end: string }, now: number, approvalThresholdCents: number) {
  const direction = r.tgt_price !== r.cur_price ? (r.tgt_price < r.cur_price ? "downgrade" : "upgrade") : (TIER_RANK[r.tgt_tier]! < TIER_RANK[r.cur_tier]! ? "downgrade" : "upgrade");
  const prorationCents = computeProrationCents(r.cur_price, r.tgt_price, new Date(r.period_start), new Date(r.period_end), new Date(now));
  const kind = direction === "upgrade" && prorationCents > approvalThresholdCents ? "upgrade_approval" : direction;
  return { direction, prorationCents, kind };
}
export const CHANGE_SQL = `SELECT cur.monthly_price_cents AS cur_price, cur.feature_tier AS cur_tier, tgt.monthly_price_cents AS tgt_price, tgt.feature_tier AS tgt_tier,
  s.current_period_start AS period_start, s.current_period_end AS period_end
  FROM subscriptions s JOIN plans cur ON cur.id = s.plan_id JOIN plans tgt ON tgt.id = ? WHERE s.id = ?`;
export const event = (a: Record<string, string | number>, version: number, now: number) => ({
  subscriptionId: a.subscriptionId, accountId: a.accountId, fromPlanId: a.fromPlanId, toPlanId: a.toPlanId,
  direction: a.direction, prorationCents: Number(a.prorationCents), version, changedAt: new Date(now).toISOString(),
});
