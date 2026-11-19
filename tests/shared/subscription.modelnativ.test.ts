/**
 * Shared behavioural and HTTP tests: the ORIGINAL subscription test files (service.test.ts and
 * http.test.ts, written for the conventional SubscriptionService) run here unchanged against the
 * Modelnativ implementation, through the embedded SDK and the original Express app.
 * Tests marked conventionalOnly(...) cover an intentional difference; its Modelnativ counterpart
 * is asserted below. The conventional run is the original test files themselves.
 */
import { describe, expect, it } from "vitest";
import { createModelnativSubscriptionService } from "../../examples/subscription-original/modelnativ/embedded.ts";

const g = globalThis as Record<string, unknown>;
g.__subscriptionImplementation = "modelnativ";
g.__subscriptionServiceFactory = (deps: Parameters<typeof createModelnativSubscriptionService>[0]) => createModelnativSubscriptionService(deps);

await import("../../examples/subscription-original/test/service.test.ts");
await import("../../examples/subscription-original/test/http.test.ts");

const { setup, admin } = await import("../../examples/subscription-original/test/helpers.ts");

describe("Modelnativ counterpart of the intentional differences", () => {
  it("a failed billing notification does not fail the request; it stays in the outbox and is delivered on retry", async () => {
    const { service, billing, db } = setup();
    billing.fail = true;
    const res = await service.changePlan(admin, { subscriptionId: "sub_a", targetPlanId: "plan_starter" });
    expect(res.status).toBe("changed");
    const row = () => db.prepare("SELECT status, attempts FROM mn_outbox").get() as { status: string; attempts: number };
    expect(row()).toMatchObject({ status: "pending", attempts: 1 }); // attempted once, scheduled for retry
    billing.fail = false;
    db.prepare("UPDATE mn_outbox SET next_attempt_at = 0").run(); // make the retry due now
    await (service as unknown as { app: { dispatcher: { drain(): Promise<unknown> } } }).app.dispatcher.drain();
    expect(row()).toMatchObject({ status: "delivered", attempts: 2 });
    expect(billing.events.at(-1)).toMatchObject({ subscriptionId: "sub_a", toPlanId: "plan_starter" });
  });
});
