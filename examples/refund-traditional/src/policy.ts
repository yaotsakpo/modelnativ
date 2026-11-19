/**
 * Refund policy. Pure: decides from server-side facts only. The customer's
 * `reason` is taken as the claimed reason; their `claims` are never treated as facts.
 */
export type Reason = "DAMAGED" | "NOT_DELIVERED" | "CHANGED_MIND" | "OTHER";

export type OrderFacts = {
  refundableCents: number;
  ageDays: number;
  carrierDamaged: boolean | null;
  carrierDelivered: boolean | null;
};

export type PolicyDecision =
  | { outcome: "allow"; amountCents: number }
  | { outcome: "review"; code: string }
  | { outcome: "refuse"; code: string };

export const MAX_REFUND_CENTS = 50_000;

const refuse = (code: string): PolicyDecision => ({ outcome: "refuse", code });
const review = (code: string): PolicyDecision => ({ outcome: "review", code });

export function decideRefund(facts: OrderFacts, reason: Reason, requestedCents?: number): PolicyDecision {
  const amountCents = requestedCents ?? facts.refundableCents;
  if (amountCents <= 0) return refuse("amount_not_positive");
  if (amountCents > facts.refundableCents) return refuse("exceeds_refundable_balance");
  if (amountCents > MAX_REFUND_CENTS) return refuse("exceeds_refund_limit");
  const allow: PolicyDecision = { outcome: "allow", amountCents };

  switch (reason) {
    case "DAMAGED":
      if (facts.ageDays > 60) return refuse("too_old");
      if (facts.carrierDamaged === null) return review("no_carrier_damage_report");
      return facts.carrierDamaged ? allow : refuse("carrier_reports_intact");
    case "NOT_DELIVERED":
      if (facts.ageDays > 45) return refuse("too_old");
      if (facts.carrierDelivered === null) return review("no_carrier_tracking");
      return facts.carrierDelivered ? refuse("carrier_reports_delivered") : allow;
    case "CHANGED_MIND":
      return facts.ageDays <= 30 ? allow : refuse("too_old");
    case "OTHER":
      return review("manual_review");
  }
}
