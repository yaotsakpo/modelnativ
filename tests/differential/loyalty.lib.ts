/** Shared loyalty differential: cases, the original runner, and a migrated runner for any app config. */
/**
 * Migration 1 (deterministic): RedemptionService.redeem vs loyalty.redeem (fixed decision, no model).
 * Same inputs, same seeded data. Cases combine several failing checks at once to test precedence.
 */
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RedemptionService, seedLoyalty, type Account, type Reward } from "@modelnativ/example-loyalty-original";
import { createApp, testEnv } from "@modelnativ/runtime";
import type { AppConfig } from "@modelnativ/runtime";
import { fulfillment } from "../../examples/loyalty-original/modelnativ/adapters.ts";
import type { Observed } from "./harness.ts";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const LOYALTY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../examples/loyalty-original/modelnativ");

export type Case = { acct: Account | null; reward: Reward | null; quantity: number; recent: number; old: number };

function state(db: Database.Database) {
  return {
    accounts: db.prepare("SELECT member_id, points FROM loyalty_accounts ORDER BY member_id").all(),
    rewards: db.prepare("SELECT id, stock FROM rewards ORDER BY id").all(),
    redemptions: db.prepare("SELECT member_id, reward_id, quantity, points FROM redemptions WHERE id NOT LIKE 'prior_%' ORDER BY member_id").all(),
  };
}
function seed(db: Database.Database, c: Case) {
  const prior = [...Array.from({ length: c.recent }, () => ({ member: "m_1", at: NOW - 3_600_000 })), ...Array.from({ length: c.old }, () => ({ member: "m_1", at: NOW - 2 * 86_400_000 }))];
  seedLoyalty(db, c.acct ? [c.acct, { member: "m_other", tenant: "t_b", points: 10_000, tier: "gold", status: "active" }] : [], c.reward ? [c.reward] : [], prior);
}

export async function runOriginal(c: Case): Promise<Observed> {
  const db = new Database(":memory:");
  seed(db, c);
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => (calls++, new Response("ok"))) as typeof fetch;
  try {
    const r = new RedemptionService(db, () => NOW, "http://fulfillment.test").redeem({ id: "m_1", tenantId: "t_a" }, { rewardId: "rw_1", quantity: c.quantity });
    await new Promise((res) => setImmediate(res));
    return r.status === "redeemed" ? { outcome: "ALLOW", amount: r.pointsSpent, state: state(db), external: calls } : { outcome: "REFUSE", reason: r.reason, state: state(db), external: calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function runMigrated(c: Case, config: AppConfig, appDir: string): Promise<Observed> {
  const db = new Database(":memory:");
  seed(db, c);
  const env = testEnv(1);
  env.clock.advance(NOW - env.clock.now());
  let calls = 0;
  const app = createApp({ ...config, destinations: () => [fulfillment("http://fulfillment.test", (async () => (calls++, new Response("ok"))) as typeof fetch)] }, appDir, { env, db });
  const principal = { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 60_000 };
  const r = await app.engines[0]!.handle({ principal, body: { rewardId: "rw_1", quantity: c.quantity }, idempotencyKey: "diff-key-0001" });
  await app.dispatcher.drain();
  const st = state(db);
  if (r.outcome === "ALLOW") return { outcome: "ALLOW", amount: Number(r.effect!.result.pointsSpent), state: st, external: calls };
  return { outcome: r.outcome as Observed["outcome"], reason: r.reason ?? r.code, state: st, external: calls };
}

export function cases(): Case[] {
  const out: Case[] = [];
  const accts: (Account | null)[] = [null];
  for (const status of ["active", "suspended"] as const) for (const tier of ["bronze", "silver", "gold"] as const) for (const points of [0, 199, 200, 600]) accts.push({ member: "m_1", tenant: "t_a", points, tier, status });
  accts.push({ member: "m_1", tenant: "t_b", points: 600, tier: "gold", status: "active" }); // account in another tenant
  const rewards: (Reward | null)[] = [null, { id: "rw_1", tenant: "t_b", cost: 100, stock: 5, minTier: "bronze" }]; // missing / other tenant
  for (const stock of [0, 1, 3]) for (const minTier of ["bronze", "silver", "gold"] as const) rewards.push({ id: "rw_1", tenant: "t_a", cost: 100, stock, minTier });
  for (const acct of accts) for (const reward of rewards) for (const quantity of [1, 2, 3]) for (const [recent, old] of [[0, 0], [2, 1], [3, 0]] as const) out.push({ acct, reward, quantity, recent, old });
  return out;
}

