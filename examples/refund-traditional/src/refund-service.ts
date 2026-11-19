import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuditSink } from "./audit.ts";
import type { Principal } from "./auth.ts";
import { decideRefund } from "./policy.ts";
import type { Clock } from "./ports.ts";
import type { RefundRequest } from "./validation.ts";

const DAY_MS = 86_400_000;

export type RefundCommand = {
  principal: Principal;
  idempotencyKey: string;
  request: RefundRequest;
  requestId: string;
};

export type RefundResult =
  | { status: "allowed"; refundId: string; amountCents: number }
  | { status: "review"; code: string }
  | { status: "refused"; code: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "conflict"; code: "idempotency_key_reused" | "concurrent_update" }
  | { status: "unavailable" };

/** Fault-injection hooks (no-ops in production). */
export type RefundServiceFaults = { beforeCommit?: () => void };

type OrderRow = { id: string; owner_id: string; created_at: number; delivered_at: number | null; refundable_cents: number; version: number };
type CarrierRow = { damaged: number | null; delivered: number | null };
type KeyRow = { request_hash: string; response: string };

class ConcurrentUpdateError extends Error {}

const toBool = (v: number | null | undefined): boolean | null => (v === null || v === undefined ? null : v === 1);

export class RefundService {
  private readonly stmts;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    private readonly faults: RefundServiceFaults = {},
  ) {
    this.stmts = {
      findKey: db.prepare<[string, string, string], KeyRow>("SELECT request_hash, response FROM idempotency_keys WHERE tenant_id = ? AND subject = ? AND key = ?"),
      saveKey: db.prepare("INSERT INTO idempotency_keys (tenant_id, subject, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
      // Tenant is part of the lookup: another tenant's order is indistinguishable from a missing one.
      findOrder: db.prepare<[string, string], OrderRow>(
        "SELECT id, owner_id, created_at, delivered_at, refundable_cents, version FROM orders WHERE id = ? AND tenant_id = ?",
      ),
      findCarrier: db.prepare<[string], CarrierRow>("SELECT damaged, delivered FROM carrier_reports WHERE order_id = ?"),
      debitOrder: db.prepare(
        "UPDATE orders SET refundable_cents = refundable_cents - ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ?",
      ),
      insertRefund: db.prepare("INSERT INTO refunds (id, tenant_id, order_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)"),
      insertOutbox: db.prepare("INSERT INTO outbox (idempotency_key, payload, status, next_attempt_at, created_at) VALUES (?, ?, 'pending', ?, ?)"),
    };
  }

  requestRefund(cmd: RefundCommand): RefundResult {
    const { principal, idempotencyKey } = cmd;
    const requestHash = hashRequest(cmd.request);
    let replayed = false;
    let result: RefundResult;

    try {
      // IMMEDIATE takes the write lock up front, so the idempotency lookup, the
      // decision and the writes are serialized against concurrent requests.
      result = this.db
        .transaction((): RefundResult => {
          const prior = this.stmts.findKey.get(principal.tenant, principal.subject, idempotencyKey);
          if (prior) {
            if (prior.request_hash !== requestHash) return { status: "conflict", code: "idempotency_key_reused" };
            replayed = true;
            return JSON.parse(prior.response) as RefundResult;
          }
          const decided = this.decideAndApply(cmd);
          this.stmts.saveKey.run(principal.tenant, principal.subject, idempotencyKey, requestHash, JSON.stringify(decided), this.clock.now());
          this.faults.beforeCommit?.();
          return decided;
        })
        .immediate();
    } catch (err) {
      result = err instanceof ConcurrentUpdateError ? { status: "conflict", code: "concurrent_update" } : { status: "unavailable" };
    }

    this.audit.write({
      event: "refund.decision",
      requestId: cmd.requestId,
      outcome: auditOutcome(result),
      detail: "code" in result ? result.code : result.status,
      tenant: principal.tenant,
      subject: principal.subject,
      orderId: cmd.request.orderId,
      reason: cmd.request.reason,
      amountCents: result.status === "allowed" ? result.amountCents : undefined,
      refundId: result.status === "allowed" ? result.refundId : undefined,
      replayed,
      // The free-text message is never recorded, only its size.
      messageLength: cmd.request.message.length,
    });
    return result;
  }

  private decideAndApply({ principal, request }: RefundCommand): RefundResult {
    const order = this.stmts.findOrder.get(request.orderId, principal.tenant);
    if (!order) return { status: "not_found" };
    if (order.owner_id !== principal.subject) return { status: "forbidden" };

    const now = this.clock.now();
    const carrier = this.stmts.findCarrier.get(order.id);
    const decision = decideRefund(
      {
        refundableCents: order.refundable_cents,
        ageDays: Math.floor((now - (order.delivered_at ?? order.created_at)) / DAY_MS),
        carrierDamaged: toBool(carrier?.damaged),
        carrierDelivered: toBool(carrier?.delivered),
      },
      request.reason,
      request.amountCents,
    );
    if (decision.outcome === "review") return { status: "review", code: decision.code };
    if (decision.outcome === "refuse") return { status: "refused", code: decision.code };

    // Optimistic check: the debit only applies to the version we decided on.
    const debit = this.stmts.debitOrder.run(decision.amountCents, order.id, principal.tenant, order.version);
    if (debit.changes !== 1) throw new ConcurrentUpdateError();

    const refundId = `rf_${randomUUID()}`;
    this.stmts.insertRefund.run(refundId, principal.tenant, order.id, decision.amountCents, now);
    const payload = { refundId, orderId: order.id, amountCents: decision.amountCents };
    this.stmts.insertOutbox.run(`refund:${refundId}`, JSON.stringify(payload), now, now);
    return { status: "allowed", refundId, amountCents: decision.amountCents };
  }
}

function hashRequest(r: RefundRequest): string {
  const canonical = [r.orderId, r.reason, r.message, r.amountCents ?? null, r.claims?.damaged ?? null, r.claims?.delivered ?? null];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function auditOutcome(r: RefundResult): string {
  switch (r.status) {
    case "allowed":
      return "allow";
    case "review":
      return "review";
    case "unavailable":
      return "error";
    default:
      return "refuse";
  }
}
