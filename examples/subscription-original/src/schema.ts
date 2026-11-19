import Database from "better-sqlite3";

export type Db = Database.Database;

export const DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_members (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'billing_manager', 'member')),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL CHECK (monthly_price_cents >= 0),
  seat_limit          INTEGER NOT NULL CHECK (seat_limit > 0),
  feature_tier        TEXT NOT NULL CHECK (feature_tier IN ('starter', 'pro', 'enterprise')),
  purchasable         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  plan_id              TEXT NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled')),
  seats_in_use         INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  promo_lock_until     TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'paid', 'void')),
  amount_cents    INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

-- Pending charges picked up by the next invoice run.
CREATE TABLE IF NOT EXISTS invoice_items (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  invoice_id      TEXT REFERENCES invoices(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  description     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_notes (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_change_history (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  from_plan_id    TEXT NOT NULL,
  to_plan_id      TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('upgrade', 'downgrade')),
  proration_cents INTEGER NOT NULL,
  changed_by      TEXT NOT NULL,
  changed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_change_history_sub ON plan_change_history (subscription_id, changed_at);

CREATE TABLE IF NOT EXISTS plan_change_requests (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  from_plan_id    TEXT NOT NULL,
  to_plan_id      TEXT NOT NULL,
  proration_cents INTEGER NOT NULL,
  requested_by    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TEXT NOT NULL
);
`;

export function openDatabase(filename = ":memory:"): Db {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  return db;
}

export interface SeedOptions {
  now?: Date;
  status?: "active" | "past_due" | "cancelled";
  planId?: string;
  seatsInUse?: number;
  promoLockUntil?: string | null;
  periodStart?: string;
  periodEnd?: string;
}

/**
 * Seeds two tenants, a handful of plans and one subscription per tenant.
 * Fixture ids are stable so tests and demos can refer to them.
 */
export function seed(db: Db, opts: SeedOptions = {}): void {
  const now = (opts.now ?? new Date("2026-03-11T00:00:00.000Z")).toISOString();
  const periodStart = opts.periodStart ?? "2026-03-01T00:00:00.000Z";
  const periodEnd = opts.periodEnd ?? "2026-03-31T00:00:00.000Z";

  const insertTenant = db.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)");
  const insertAccount = db.prepare("INSERT INTO accounts (id, tenant_id, name) VALUES (?, ?, ?)");
  const insertMember = db.prepare("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, ?)");
  const insertPlan = db.prepare(
    "INSERT INTO plans (id, name, monthly_price_cents, seat_limit, feature_tier, purchasable) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertSub = db.prepare(
    `INSERT INTO subscriptions (id, account_id, plan_id, status, seats_in_use, current_period_start, current_period_end, promo_lock_until, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );

  db.transaction(() => {
    insertTenant.run("tenant_a", "Acme Holdings");
    insertTenant.run("tenant_b", "Globex");

    insertAccount.run("acct_a", "tenant_a", "Acme Corp");
    insertAccount.run("acct_b", "tenant_b", "Globex Corp");

    insertMember.run("acct_a", "user_admin", "admin");
    insertMember.run("acct_a", "user_billing", "billing_manager");
    insertMember.run("acct_a", "user_member", "member");
    insertMember.run("acct_b", "user_b_admin", "admin");

    insertPlan.run("plan_starter", "Starter", 2_900, 5, "starter", 1);
    insertPlan.run("plan_pro", "Pro", 9_900, 25, "pro", 1);
    insertPlan.run("plan_business", "Business", 49_900, 100, "pro", 1);
    insertPlan.run("plan_enterprise", "Enterprise", 299_900, 1_000, "enterprise", 1);
    insertPlan.run("plan_legacy", "Legacy Pro", 7_900, 20, "pro", 0);

    insertSub.run(
      "sub_a",
      "acct_a",
      opts.planId ?? "plan_pro",
      opts.status ?? "active",
      opts.seatsInUse ?? 3,
      periodStart,
      periodEnd,
      opts.promoLockUntil ?? null,
      now,
    );
    insertSub.run("sub_b", "acct_b", "plan_pro", "active", 3, periodStart, periodEnd, null, now);
  })();
}
