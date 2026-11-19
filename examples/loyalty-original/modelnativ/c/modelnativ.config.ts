import { defineApp } from "@modelnativ/runtime";
import { fulfillment, redeemAdapter, tools } from "../b/adapters.ts";

export default defineApp({
  contracts: ["loyalty.redeem.yaml"],
  tools: ({ db, env }) => tools(db, () => env.clock.now()),
  adapters: () => [redeemAdapter],
  destinations: () => [fulfillment(process.env.FULFILLMENT_URL ?? "http://localhost:9/fulfillment")],
});
