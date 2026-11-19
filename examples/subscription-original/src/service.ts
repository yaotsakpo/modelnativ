import { randomUUID } from "node:crypto";
import type { Db } from "./schema.ts";
import type { BillingProvider } from "./billing-provider.ts";
import { computeProrationCents } from "./proration.ts";

export type Role = "admin" | "billing_manager" | "member";
export type FeatureTier = "starter" | "pro" | "enterprise";
export type SubscriptionStatus = "active" | "past_due" | "cancelled";
export type ChangeDirection = "upgrade" | "downgrade";

export interface Caller {
  userId: string;
  tenantId: string;
}

export interface ChangePlanRequest {
  subscriptionId: string;
  targetPlanId: string;
  /** Optional optimistic-concurrency token: the subscription version the client last saw. */
  expectedVersion?: number;
}

export type RejectionReason =
  | "not_found"
  | "forbidden"
  | "subscription_past_due"
  | "subscription_cancelled"
  | "plan_not_found"
  | "plan_not_purchasable"
  | "same_plan"
  | "invoice_pending"
  | "plan_change_limit_reached"
  | "promo_lock_active"
  | "seat_limit_exceeded"
  | "version_conflict";

export type ChangePlanResponse =
  | {
      status: "changed";
      subscriptionId: string;
      fromPlanId: string;
      toPlanId: string;
      direction: ChangeDirection;
      prorationCents: number;
      version: number;
    }
  | {
      status: "pending_approval";
      subscriptionId: string;
      approvalRequestId: string;
      fromPlanId: string;
      toPlanId: string;
      direction: "upgrade";
      prorationCents: number;
    }
  | {
      status: "rejected";
      reason: RejectionReason;
    };

export interface SubscriptionServiceConfig {
  /** Upgrades whose prorated charge is strictly above this need manual approval. */
  approvalThresholdCents: number;
  /** Maximum number of applied plan changes per billing period. */
  maxPlanChangesPerPeriod: number;
}

export const DEFAULT_CONFIG: SubscriptionServiceConfig = {
  approvalThresholdCents: 25_000,
  maxPlanChangesPerPeriod: 2,
};

interface Logger {
  warn(msg: string, meta?: unknown): void;
}

export interface SubscriptionServiceDeps {
  db: Db;
  billing: BillingProvider;
  config?: Partial<SubscriptionServiceConfig>;
  now?: () => Date;
  logger?: Logger;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  tenant_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  seats_in_use: number;
  current_period_start: string;
  current_period_end: string;
  promo_lock_until: string | null;
  version: number;
}

interface PlanRow {
  id: string;
  monthly_price_cents: number;
  seat_limit: number;
  feature_tier: FeatureTier;
  purchasable: number;
}

const TIER_RANK: Record<FeatureTier, number> = { starter: 0, pro: 1, enterprise: 2 };
const ROLES_ALLOWED_TO_CHANGE_PLAN: ReadonlySet<Role> = new Set(["admin", "billing_manager"]);

class VersionConflictError extends Error {
  constructor() {
    super("subscription was modified concurrently");
  }
}

const reject = (reason: RejectionReason): ChangePlanResponse => ({ status: "rejected", reason });

export class SubscriptionService {
  private readonly db: Db;
  private readonly billing: BillingProvider;
  private readonly config: SubscriptionServiceConfig;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(deps: SubscriptionServiceDeps) {
    this.db = deps.db;
    this.billing = deps.billing;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  async changePlan(caller: Caller, request: ChangePlanRequest): Promise<ChangePlanResponse> {
    const now = this.now();

    // 1. Tenant isolation: another tenant's subscription looks exactly like a missing one.
    const sub = this.db
      .prepare(
        `SELECT s.id, s.account_id, a.tenant_id, s.plan_id, s.status, s.seats_in_use,
                s.current_period_start, s.current_period_end, s.promo_lock_until, s.version
           FROM subscriptions s
           JOIN accounts a ON a.id = s.account_id
          WHERE s.id = ?`,
      )
      .get(request.subscriptionId) as SubscriptionRow | undefined;
    if (!sub || sub.tenant_id !== caller.tenantId) return reject("not_found");

    // 2. Authorization: admin or billing manager of this account.
    const membership = this.db
      .prepare("SELECT role FROM account_members WHERE account_id = ? AND user_id = ?")
      .get(sub.account_id, caller.userId) as { role: Role } | undefined;
    if (!membership || !ROLES_ALLOWED_TO_CHANGE_PLAN.has(membership.role)) return reject("forbidden");

    // 3. Subscription state.
    if (sub.status === "past_due") return reject("subscription_past_due");
    if (sub.status === "cancelled") return reject("subscription_cancelled");

    // 4. Target plan validity.
    const currentPlan = this.getPlan(sub.plan_id);
    if (!currentPlan) throw new Error(`subscription ${sub.id} references unknown plan ${sub.plan_id}`);
    const targetPlan = this.getPlan(request.targetPlanId);
    if (!targetPlan) return reject("plan_not_found");
    if (!targetPlan.purchasable) return reject("plan_not_purchasable");
    if (targetPlan.id === currentPlan.id) return reject("same_plan");

    // 5. Billing state.
    const pendingInvoice = this.db
      .prepare("SELECT 1 FROM invoices WHERE subscription_id = ? AND status = 'pending' LIMIT 1")
      .get(sub.id);
    if (pendingInvoice) return reject("invoice_pending");

    const { count: changesThisPeriod } = this.db
      .prepare("SELECT COUNT(*) AS count FROM plan_change_history WHERE subscription_id = ? AND changed_at >= ?")
      .get(sub.id, sub.current_period_start) as { count: number };
    if (changesThisPeriod >= this.config.maxPlanChangesPerPeriod) return reject("plan_change_limit_reached");

    // 6. Downgrade-specific constraints.
    const direction = this.direction(currentPlan, targetPlan);
    if (direction === "downgrade") {
      if (sub.promo_lock_until && new Date(sub.promo_lock_until).getTime() > now.getTime()) {
        return reject("promo_lock_active");
      }
      if (sub.seats_in_use > targetPlan.seat_limit) return reject("seat_limit_exceeded");
    }

    // 7. Proration and approval.
    const prorationCents = computeProrationCents(
      currentPlan.monthly_price_cents,
      targetPlan.monthly_price_cents,
      new Date(sub.current_period_start),
      new Date(sub.current_period_end),
      now,
    );

    if (direction === "upgrade" && prorationCents > this.config.approvalThresholdCents) {
      const approvalRequestId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO plan_change_requests (id, subscription_id, from_plan_id, to_plan_id, proration_cents, requested_by, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(approvalRequestId, sub.id, currentPlan.id, targetPlan.id, prorationCents, caller.userId, now.toISOString());
      return {
        status: "pending_approval",
        subscriptionId: sub.id,
        approvalRequestId,
        fromPlanId: currentPlan.id,
        toPlanId: targetPlan.id,
        direction,
        prorationCents,
      };
    }

    // 8. Apply atomically.
    const expectedVersion = request.expectedVersion ?? sub.version;
    const nowIso = now.toISOString();
    const apply = this.db.transaction(() => {
      const updated = this.db
        .prepare("UPDATE subscriptions SET plan_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .run(targetPlan.id, nowIso, sub.id, expectedVersion);
      if (updated.changes !== 1) throw new VersionConflictError();

      const description = `Proration ${currentPlan.id} -> ${targetPlan.id}`;
      if (prorationCents > 0) {
        this.db
          .prepare(
            "INSERT INTO invoice_items (id, subscription_id, invoice_id, amount_cents, description, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
          )
          .run(randomUUID(), sub.id, prorationCents, description, nowIso);
      } else if (prorationCents < 0) {
        this.db
          .prepare("INSERT INTO credit_notes (id, subscription_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), sub.id, -prorationCents, description, nowIso);
      }

      this.db
        .prepare(
          `INSERT INTO plan_change_history (id, subscription_id, from_plan_id, to_plan_id, direction, proration_cents, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), sub.id, currentPlan.id, targetPlan.id, direction, prorationCents, caller.userId, nowIso);

      return expectedVersion + 1;
    });

    let newVersion: number;
    try {
      newVersion = apply.immediate();
    } catch (err) {
      if (err instanceof VersionConflictError) return reject("version_conflict");
      throw err;
    }

    // 9. After commit: tell the billing provider. Fire-and-forget; reconciliation catches misses.
    this.billing
      .notifyPlanChanged({
        subscriptionId: sub.id,
        accountId: sub.account_id,
        fromPlanId: currentPlan.id,
        toPlanId: targetPlan.id,
        direction,
        prorationCents,
        version: newVersion,
        changedAt: nowIso,
      })
      .catch((err: unknown) => this.logger.warn("billing provider notification failed", { subscriptionId: sub.id, err }));

    return {
      status: "changed",
      subscriptionId: sub.id,
      fromPlanId: currentPlan.id,
      toPlanId: targetPlan.id,
      direction,
      prorationCents,
      version: newVersion,
    };
  }

  private getPlan(id: string): PlanRow | undefined {
    return this.db
      .prepare("SELECT id, monthly_price_cents, seat_limit, feature_tier, purchasable FROM plans WHERE id = ?")
      .get(id) as PlanRow | undefined;
  }

  /** Cheaper plan is a downgrade; at equal price, a lower feature tier is a downgrade. */
  private direction(from: PlanRow, to: PlanRow): ChangeDirection {
    if (to.monthly_price_cents !== from.monthly_price_cents) {
      return to.monthly_price_cents < from.monthly_price_cents ? "downgrade" : "upgrade";
    }
    return TIER_RANK[to.feature_tier] < TIER_RANK[from.feature_tier] ? "downgrade" : "upgrade";
  }
}
