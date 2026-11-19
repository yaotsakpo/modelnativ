// Business constants, in ONE place. The contract names them (policy.*), the gate checks rules
// against them, and the adapter's in-transaction re-check receives them as effect arguments.
export const LOYALTY_POLICY = {
  "policy.dailyLimit": 3, // service.ts:9 DAILY_LIMIT
};
