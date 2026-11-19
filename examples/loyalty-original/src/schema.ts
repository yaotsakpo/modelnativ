import type Database from "better-sqlite3";

/** The original service's tables (as they exist in the legacy app's database). */
export const LOYALTY_SCHEMA = `
CREATE TABLE IF NOT EXISTS loyalty_accounts (member_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, points INTEGER NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cost INTEGER NOT NULL, stock INTEGER NOT NULL, min_tier TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS redemptions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, reward_id TEXT NOT NULL, quantity INTEGER NOT NULL, points INTEGER NOT NULL, created_at INTEGER NOT NULL);
`;

export type Account = { member: string; tenant: string; points: number; tier: "bronze" | "silver" | "gold"; status: "active" | "suspended" };
export type Reward = { id: string; tenant: string; cost: number; stock: number; minTier: "bronze" | "silver" | "gold" };

export function seedLoyalty(db: Database.Database, accounts: Account[], rewards: Reward[], priorRedemptions: { member: string; at: number }[] = []) {
  db.exec(LOYALTY_SCHEMA);
  const a = db.prepare("INSERT INTO loyalty_accounts VALUES (?,?,?,?,?)");
  for (const x of accounts) a.run(x.member, x.tenant, x.points, x.tier, x.status);
  const r = db.prepare("INSERT INTO rewards VALUES (?,?,?,?,?)");
  for (const x of rewards) r.run(x.id, x.tenant, x.cost, x.stock, x.minTier);
  const d = db.prepare("INSERT INTO redemptions VALUES (?,?,?,?,?,?)");
  priorRedemptions.forEach((p, i) => d.run(`prior_${i}`, p.member, "rw_any", 1, 0, p.at));
}
