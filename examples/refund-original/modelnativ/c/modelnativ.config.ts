import { defineApp } from "@modelnativ/runtime";
import { refundRequestAdapter, tools } from "../b/adapters.ts";

export default defineApp({
  contracts: ["refund.request.yaml"],
  tools: ({ db, env }) => tools(db, () => env.clock.now()),
  adapters: () => [refundRequestAdapter],
});
