import { buildRefundApp, type SeedOrder } from "@modelnativ/example-refund-migrated";
import type { ModelAdapter, ModelInput } from "@modelnativ/model-adapter";
import { ScriptedModel } from "@modelnativ/model-adapter";
import { testEnv, type Env } from "@modelnativ/runtime";
import type { Principal } from "@modelnativ/contract-schema";
import type { ReadTool } from "@modelnativ/runtime";

export function makeApp(model: ModelAdapter, opts: { seed?: number; env?: Partial<Env>; serialize?: boolean; seedOrders?: SeedOrder[]; tools?: ReadTool[]; contractPath?: string; adapter?: import("@modelnativ/effect-executor").EffectAdapter } = {}) {
  const env = testEnv(opts.seed ?? 1, opts.env);
  const app = buildRefundApp({ env, model, serialize: opts.serialize, seedOrders: opts.seedOrders, tools: opts.tools, seed: opts.seed ?? 1, contractPath: opts.contractPath, adapter: opts.adapter });
  return { ...app, env };
}

export function alice(env: { clock: { now(): number } }, over: Partial<Principal> = {}): Principal {
  return { subject: "u_alice", tenant: "t_acme", sessionId: "s_1", scopes: ["refund:request"], expiresAt: env.clock.now() + 600_000, ...over };
}

export const propose = (category: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) => (input: ModelInput) => ({
  operation: input.operation,
  contractVersion: input.contractVersion,
  decision: "PROPOSE_EFFECT",
  category,
  effects: [{ tool: "payments.refund", args }],
  ...over,
});

export const fullRefund = { orderId: { ref: "order.id" }, amountCents: { ref: "order.refundableCents" } };
export const scripted = (f: (i: ModelInput, n: number) => unknown) => new ScriptedModel(f);

/** The observable state that matters for "no unauthorized effect". */
export function effectsState(db: import("better-sqlite3").Database) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    refunds: n("SELECT COUNT(*) AS n FROM refunds"),
    effects: n("SELECT COUNT(*) AS n FROM mn_effects"),
    outbox: n("SELECT COUNT(*) AS n FROM mn_outbox"),
    balances: db.prepare("SELECT id, refundable_cents, version FROM orders ORDER BY id").all(),
  };
}
