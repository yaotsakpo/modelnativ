import type { Clock, PaymentProvider, ProviderRefundRequest, SecretStore } from "../ports.ts";

/** In-memory payment provider for tests: idempotent by key, with outage injection. */
export class SimulatedPaymentProvider implements PaymentProvider {
  private readonly payments = new Map<string, string>();
  private calls = 0;
  private failures = 0;

  constructor(private acceptedApiKey: string) {}

  async createRefund(req: ProviderRefundRequest, apiKey: string): Promise<{ providerRefundId: string }> {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("503 Service Unavailable");
    }
    // Like some real providers, the error echoes the credential; callers must scrub it.
    if (apiKey !== this.acceptedApiKey) throw new Error(`401 Unauthorized: invalid API key ${apiKey}`);
    const existing = this.payments.get(req.idempotencyKey);
    if (existing) return { providerRefundId: existing };
    const id = `pr_${this.payments.size + 1}`;
    this.payments.set(req.idempotencyKey, id);
    return { providerRefundId: id };
  }

  acceptApiKey(key: string): void {
    this.acceptedApiKey = key;
  }
  failNext(n: number): void {
    this.failures = n;
  }
  paymentCount(): number {
    return this.payments.size;
  }
  callCount(): number {
    return this.calls;
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }
  get(name: string): string {
    const v = this.values.get(name);
    if (v === undefined) throw new Error(`secret not found: ${name}`);
    return v;
  }
  set(name: string, value: string): void {
    this.values.set(name, value);
  }
  all(): string[] {
    return [...this.values.values()];
  }
}

export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
