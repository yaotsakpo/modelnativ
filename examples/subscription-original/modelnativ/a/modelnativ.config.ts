import { defineApp } from "@modelnativ/runtime";
import type { SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";
import { applyAdapter, approvalAdapter, tools } from "./adapters.ts";
import { DEMO, billingDestinations, demoSetup } from "../app-common.ts";

/** The original's config (approval threshold, plan changes per period) stays configurable. */
export const makeApp = (cfg: Partial<SubscriptionServiceConfig> = {}) =>
  defineApp({
    contracts: ["plan.change.yaml"],
    tools: ({ db, env }) => tools(db, () => env.clock.now(), cfg),
    adapters: () => [applyAdapter, approvalAdapter],
    destinations: billingDestinations,
    setup: demoSetup,
    demo: DEMO,
  });

export default makeApp();
