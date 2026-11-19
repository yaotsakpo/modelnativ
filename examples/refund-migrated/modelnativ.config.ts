/** The refund example as a Modelnativ app: `modelnativ serve examples/refund-migrated`. */
import { defineApp } from "@modelnativ/runtime";
import { PaymentProvider, readTools, refundAdapter, seed } from "./src/domain.ts";

export default defineApp({
  contracts: ["contracts/refund.create.yaml"],
  tools: ({ db, env }) => readTools(db, () => env.clock.now()),
  adapters: () => [refundAdapter],
  destinations: ({ secrets }) => {
    let key = "sk_test_psp_0001";
    try {
      key = secrets.get("psp.apiKey");
    } catch {
      /* dev: default test key */
    }
    return [new PaymentProvider(key).destination()];
  },
  setup: ({ db, env }) => seed(db, env.clock.now()),
});
