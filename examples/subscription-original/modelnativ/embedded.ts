/**
 * Embedded SDK: the original `SubscriptionService` interface, implemented by Modelnativ.
 * Drop-in for the original service behind the UNCHANGED Express app (src/app.ts) and its tests.
 *
 *   const service = createModelnativSubscriptionService({ db, billing, config, now });
 *   createApp({ service, tokens })   // the original controller, routes, auth and HTTP mapping
 *
 * Mapping, and the intentional differences from the original:
 * - every call is one Modelnativ operation (`plan.change`) with a fresh idempotency key, because the
 *   original API has none; callers who want retry safety should pass their own key through `execute`
 * - business answers become the original `ChangePlanResponse`; infrastructure outcomes (e.g. a
 *   commit failure) throw `ModelnativRetryableError` (the original threw the raw error)
 * - the billing notification goes through the outbox and is delivered right after the call; a failed
 *   delivery is retried later (the original logged it once and dropped it)
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createModelnativ, type Normalized } from "@modelnativ/core";
import { CryptoRandom, NO_FAULTS, createApp, freeScheduler, type BuiltApp } from "@modelnativ/runtime";
import type { BillingProvider, Caller, ChangePlanRequest, ChangePlanResponse, SubscriptionServiceConfig } from "@modelnativ/example-subscription-original";
import { makeApp } from "./c/modelnativ.config.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "c");

export type EmbeddedDeps = { db: Database.Database; billing: BillingProvider; config?: Partial<SubscriptionServiceConfig>; now?: () => Date };
export type EmbeddedSubscriptionService = { changePlan(caller: Caller, request: ChangePlanRequest): Promise<ChangePlanResponse>; app: BuiltApp };

export function createModelnativSubscriptionService(deps: EmbeddedDeps): EmbeddedSubscriptionService {
  const now = deps.now ?? (() => new Date());
  const clock = { now: () => now().getTime(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()) };
  const env = { clock, random: new CryptoRandom(), scheduler: freeScheduler, faults: NO_FAULTS };
  const billing = { name: "billing", secrets: [], send: async (p: Record<string, unknown>) => (await deps.billing.notifyPlanChanged(p as never), { externalId: `${p.subscriptionId}:${p.version}` }) };
  const app = createApp({ ...makeApp(deps.config), destinations: () => [billing] }, APP_DIR, { env, db: deps.db });
  const mn = createModelnativ(app.engines, { modes: { "plan.change": "modelnativ" } });
  const bound = mn.bind(
    "plan.change",
    async (_caller: Caller, _request: ChangePlanRequest): Promise<ChangePlanResponse> => {
      throw new Error("legacy implementation not wired in modelnativ mode");
    },
    {
      principal: (caller: Caller) => ({ subject: caller.userId, tenant: caller.tenantId, sessionId: "embedded", scopes: ["subscription:change-plan"], expiresAt: clock.now() + 60_000 }),
      input: (_caller: Caller, req: ChangePlanRequest) => Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined)),
      idempotencyKey: () => `embedded-${randomUUID()}`,
      output: (r): ChangePlanResponse => {
        if (r.outcome === "ALLOW") return r.effect!.result as ChangePlanResponse;
        if (r.outcome === "REFUSE" && r.reason) return { status: "rejected", reason: r.reason as never };
        throw new Error(`unexpected outcome ${r.outcome} ${r.code ?? ""}`);
      },
      normalizeLegacy: (x): Normalized => ({ outcome: x.status === "rejected" ? "REFUSE" : "ALLOW" }),
      normalizeModelnativ: (x): Normalized => ({ outcome: x.outcome === "ALLOW" ? "ALLOW" : "REFUSE" }),
    },
  );
  return {
    app,
    async changePlan(caller, request) {
      const res = await bound(caller, request);
      await app.dispatcher.drain(); // deliver the billing notification now (retried later if it fails)
      return res;
    },
  };
}
