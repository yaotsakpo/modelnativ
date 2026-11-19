/**
 * The ORIGINAL service's refund policy, written the conventional way. The
 * customer picks a reason from a dropdown; this code trusts the reason and
 * checks it against the order and the carrier record. Kept untouched as the
 * reference implementation for benchmarks and (Phase 3) differential tests.
 */
export type Reason = "DAMAGED" | "NOT_DELIVERED" | "CHANGED_MIND" | "OTHER";
export type Order = { id: string; tenantId: string; ownerId: string; ageDays: number; refundableCents: number };
export type Carrier = { damaged: boolean | null; delivered: boolean | null };
export type Decision =
  | { outcome: "ALLOW"; amountCents: number }
  | { outcome: "REFUSE"; reason: string }
  | { outcome: "REVIEW"; reason: string };

export const MAX_REFUND_CENTS = 50000;

export function decideRefund(user: { id: string; tenantId: string }, order: Order | null, carrier: Carrier | null, reason: Reason): Decision {
  if (!order || order.tenantId !== user.tenantId) return { outcome: "REFUSE", reason: "not_found" };
  if (order.ownerId !== user.id) return { outcome: "REFUSE", reason: "forbidden" };
  if (order.refundableCents <= 0) return { outcome: "REFUSE", reason: "nothing_to_refund" };
  if (order.refundableCents > MAX_REFUND_CENTS) return { outcome: "REFUSE", reason: "over_limit" };
  switch (reason) {
    case "DAMAGED":
      if (order.ageDays > 60) return { outcome: "REFUSE", reason: "too_old" };
      if (carrier?.damaged == null) return { outcome: "REVIEW", reason: "needs_damage_report" };
      if (!carrier.damaged) return { outcome: "REFUSE", reason: "carrier_says_intact" };
      return { outcome: "ALLOW", amountCents: order.refundableCents };
    case "NOT_DELIVERED":
      if (order.ageDays > 45) return { outcome: "REFUSE", reason: "too_old" };
      if (carrier?.delivered == null) return { outcome: "REVIEW", reason: "needs_tracking" };
      if (carrier.delivered) return { outcome: "REFUSE", reason: "carrier_says_delivered" };
      return { outcome: "ALLOW", amountCents: order.refundableCents };
    case "CHANGED_MIND":
      if (order.ageDays > 30) return { outcome: "REFUSE", reason: "too_old" };
      return { outcome: "ALLOW", amountCents: order.refundableCents };
    default:
      return { outcome: "REVIEW", reason: "other" };
  }
}
