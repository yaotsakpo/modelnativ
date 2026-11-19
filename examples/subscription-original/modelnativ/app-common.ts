// Shared by the A, B and C app configs of the subscription example: demo database, billing
// destination choice, and the demo identity for `modelnativ serve --dev`.
import type { AppConfig, AppContext } from "@modelnativ/runtime";
import type { Destination } from "@modelnativ/effect-executor";
import { DDL, seed } from "@modelnativ/example-subscription-original";
import { billing } from "./a/adapters.ts";

/** Fresh database for a demo: the original schema and fixtures, with a billing period around today. */
export function demoSetup({ db, env }: AppContext) {
  db.exec(DDL);
  const now = new Date(env.clock.now());
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  seed(db, { now, periodStart: start.toISOString(), periodEnd: end.toISOString() });
}

/** With BILLING_URL: the HTTP billing provider (key from the secret store). Without: log the event. */
export function billingDestinations(): Destination[] {
  if (process.env.BILLING_URL) return [billing(process.env.BILLING_URL)];
  return [{ name: "billing", secrets: [], send: async (p) => (console.log("billing <-", JSON.stringify(p)), { externalId: `${p.subscriptionId}:${p.version}` }) }];
}

/** The seeded account admin (tenant_a); used only to print a demo token in --dev mode. */
export const DEMO: NonNullable<AppConfig["demo"]> = {
  principal: { subject: "user_admin", tenant: "tenant_a", scopes: ["subscription:change-plan"] },
  operation: "plan.change",
  request: { subscriptionId: "sub_a", targetPlanId: "plan_starter" },
};
