/**
 * Prorated amount for switching from `oldPriceCents` to `newPriceCents` (monthly prices)
 * for the remainder of the current billing period.
 *
 *   proration = (newPrice - oldPrice) * remainingSeconds / periodSeconds
 *
 * - Time is measured in whole seconds; `now` is clamped into [periodStart, periodEnd].
 * - Result is integer cents, rounded to the nearest cent, ties rounded half away from zero
 *   (so +0.5 -> +1 charge, -0.5 -> -1 credit).
 * - Positive = amount to charge, negative = amount to credit.
 * - Arithmetic is done in BigInt so large prices times long periods never lose precision.
 */
export function computeProrationCents(
  oldPriceCents: number,
  newPriceCents: number,
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): number {
  const periodSeconds = Math.floor((periodEnd.getTime() - periodStart.getTime()) / 1000);
  if (periodSeconds <= 0) return 0;

  const rawRemaining = Math.floor((periodEnd.getTime() - now.getTime()) / 1000);
  const remainingSeconds = Math.min(Math.max(rawRemaining, 0), periodSeconds);

  const numerator = BigInt(newPriceCents - oldPriceCents) * BigInt(remainingSeconds);
  return divideRoundHalfAwayFromZero(numerator, BigInt(periodSeconds));
}

function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let quotient = abs / denominator;
  const remainder = abs % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  const result = Number(quotient);
  return negative ? -result : result;
}
