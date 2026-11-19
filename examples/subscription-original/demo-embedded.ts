/**
 * Run the ORIGINAL subscription Express app (unchanged controller, routes, auth, HTTP mapping)
 * with Modelnativ inside it via the embedded SDK, on an in-memory demo database.
 *   pnpm demo:subscription:embedded              # Modelnativ inside the original app
 *   pnpm demo:subscription:embedded --conventional   # the original service, for comparison
 */
import { randomBytes } from "node:crypto";
import { DDL, SubscriptionService, createApp, openDatabase, seed, type BillingProvider, type Caller } from "@modelnativ/example-subscription-original";
import { createModelnativSubscriptionService } from "./modelnativ/embedded.ts";

const conventional = process.argv.includes("--conventional");
const port = Number(process.env.PORT ?? 8081);
const db = openDatabase();
void DDL; // openDatabase() already applied the schema
const now = new Date();
seed(db, { now, periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() });
const billing: BillingProvider = { notifyPlanChanged: async (e) => void console.log("billing <-", JSON.stringify(e)) };
const service = conventional ? new SubscriptionService({ db, billing }) : createModelnativSubscriptionService({ db, billing });
const token = randomBytes(16).toString("hex");
const tokens = new Map<string, Caller>([[token, { userId: "user_admin", tenantId: "tenant_a" }]]);
const server = createApp({ service: service as SubscriptionService, tokens }).listen(port, () => {
  const bound = (server.address() as { port: number }).port; // PORT=0: the OS picks a free port
  console.log(`original subscription API on :${bound} (${conventional ? "conventional service" : "Modelnativ via the embedded SDK"})`);
  console.log(`try:\n  curl -s localhost:${bound}/subscriptions/sub_a/plan-change -H "authorization: Bearer ${token}" -H "content-type: application/json" -d '{"targetPlanId":"plan_starter"}'`);
});
