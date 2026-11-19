/** Infrastructure seams. Production wires real implementations; tests inject fakes. */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Read access to a secret manager. Implementations keep a periodically refreshed
 * cache, so `get` is synchronous and always returns the current version.
 */
export interface SecretStore {
  get(name: string): string;
}

export const SECRET_TOKEN_SIGNING_KEY = "auth/token-signing-key";
export const SECRET_PAYMENT_API_KEY = "payments/api-key";

export type ProviderRefundRequest = {
  idempotencyKey: string;
  refundId: string;
  orderId: string;
  amountCents: number;
};

/** Client for the external payment provider. Must dedupe on `idempotencyKey`. */
export interface PaymentProvider {
  createRefund(req: ProviderRefundRequest, apiKey: string): Promise<{ providerRefundId: string }>;
}
