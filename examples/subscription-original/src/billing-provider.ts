export interface PlanChangedEvent {
  subscriptionId: string;
  accountId: string;
  fromPlanId: string;
  toPlanId: string;
  direction: "upgrade" | "downgrade";
  prorationCents: number;
  version: number;
  changedAt: string;
}

export interface BillingProvider {
  notifyPlanChanged(event: PlanChangedEvent): Promise<void>;
}

/** Posts plan changes to the external billing provider's webhook endpoint. */
export class HttpBillingProvider implements BillingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notifyPlanChanged(event: PlanChangedEvent): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/subscriptions/${encodeURIComponent(event.subscriptionId)}/plan-changed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "idempotency-key": `${event.subscriptionId}:${event.version}`,
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(`billing provider responded ${res.status}`);
    }
  }
}
