/**
 * Conformance harness: the guarantees any refund implementation must provide
 * before its size can be compared with Modelnativ's. Implementation-neutral:
 * each implementation supplies an adapter that maps its own responses onto
 * `Kind` and exposes the hooks below.
 *
 * Domain: the tables and seed data of examples/refund-migrated (DOMAIN_SCHEMA, SEED).
 * Policy (the customer picks `reason`; an implementation without a model trusts
 * it as the CLAIMED reason, but never trusts the customer's `claims` as facts):
 *   - amount = body.amountCents if given, else the full refundable balance;
 *     must be > 0, <= refundable balance, <= 50000, else POLICY
 *   - DAMAGED:       carrier damaged=true and ageDays <= 60 -> ALLOW;
 *                    carrier damaged unknown -> REVIEW; carrier says intact or too old -> POLICY
 *   - NOT_DELIVERED: carrier delivered=false and ageDays <= 45 -> ALLOW;
 *                    unknown -> REVIEW; carrier says delivered or too old -> POLICY
 *   - CHANGED_MIND:  ageDays <= 30 -> ALLOW, else POLICY
 *   - OTHER:         REVIEW
 *   - the caller must own the order (FORBIDDEN) in their tenant (NOT_FOUND, no data leaked)
 */
export type Kind =
  | "ALLOW"
  | "REVIEW"
  | "POLICY" // refused by business rules / invariants
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID" // bad input or missing idempotency key
  | "CONFLICT" // idempotency key reused for a different request, or unresolved concurrent update
  | "UNAVAILABLE"; // infrastructure failure; nothing committed

export type RefundBody = {
  orderId: string;
  reason: "DAMAGED" | "NOT_DELIVERED" | "CHANGED_MIND" | "OTHER";
  /** Free text; MUST NOT appear verbatim in audit output. Unique per request in this suite. */
  message: string;
  amountCents?: number;
  /** The customer's own claims. Never sufficient on their own. */
  claims?: { damaged?: boolean; delivered?: boolean };
  [extra: string]: unknown;
};

export type SubmitResult = { kind: Kind; refundId?: string; amountCents?: number; raw: unknown };

export interface Instance {
  /** Issue a credential through the implementation's own identity mechanism. */
  token(p: { subject: string; tenant: string; scopes: string[]; ttlMs?: number }): string;
  submit(r: { token: string | null; body: Record<string, unknown>; key: string | null }): Promise<SubmitResult>;
  refundCount(): number;
  balance(orderId: string): number;
  outboxStatuses(): string[];
  /** Run the effect dispatcher once over everything due. May throw on an injected crash. */
  drain(): Promise<void>;
  /** Move the implementation's clock forward. */
  advance(ms: number): void;
  provider: { payments(): number; calls(): number; failNext(n: number): void };
  faults: {
    /** The next delivery reaches the provider, then the worker dies before recording it. */
    crashAfterSendOnce(): void;
    /** The next refund commit fails inside its transaction. */
    failNextCommit(): void;
  };
  /** Rotate the payment provider API key in the secret store; `providerAccepts` sets the provider side. */
  rotateSecret(value: string, providerAccepts: boolean): void;
  /** The current provider API key value, for leak checks. */
  secretValues(): string[];
  /** Everything the implementation wrote to its audit/log output. */
  auditDump(): string;
  close(): Promise<void> | void;
}

export interface RefundImpl {
  name: string;
  /** Fresh, seeded instance. `clockStart` is ms since epoch; SEED ages are relative to it. */
  create(opts: { clockStart: number }): Promise<Instance> | Instance;
}
