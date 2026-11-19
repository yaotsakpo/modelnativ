import express from "express";
import type Database from "better-sqlite3";
import { decideRefund, type Decision, type Reason } from "./policy.ts";

const DAY = 86_400_000;
const REASONS = ["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "OTHER"];

export type User = { id: string; tenantId: string };
export type RefundRequest = { orderId: string; reason: Reason; message?: string };
export type RefundResponse = Decision & { refundId?: string };

/** The business-logic seam. The controller below depends on this interface only. */
export interface RefundService {
  requestRefund(user: User, req: RefundRequest, idempotencyKey: string): Promise<RefundResponse>;
}

/** The ORIGINAL implementation: handwritten policy + write, in one transaction. */
export function createLegacyRefundService(db: Database.Database, now: () => number, newId: () => string = () => `rf_${Math.random().toString(36).slice(2, 14)}`): RefundService {
  const loadOrder = (id: string) => {
    const r = db.prepare("SELECT * FROM orders WHERE id=?").get(id) as any;
    return r && { id: r.id, tenantId: r.tenant_id, ownerId: r.owner_id, ageDays: Math.floor((now() - (r.delivered_at ?? r.created_at)) / DAY), refundableCents: r.refundable_cents };
  };
  return {
    async requestRefund(user, { orderId, reason }) {
      const tx = db.transaction((): RefundResponse => {
        const o = loadOrder(orderId);
        const c = db.prepare("SELECT damaged, delivered FROM carrier_reports WHERE order_id=?").get(orderId) as any;
        const carrier = c && { damaged: c.damaged === null ? null : c.damaged === 1, delivered: c.delivered === null ? null : c.delivered === 1 };
        const d = decideRefund(user, o ?? null, carrier ?? null, reason);
        if (d.outcome !== "ALLOW") return d;
        const id = newId();
        db.prepare("UPDATE orders SET refundable_cents = refundable_cents - ?, version = version + 1 WHERE id=?").run(d.amountCents, orderId);
        db.prepare("INSERT INTO refunds(id, tenant_id, order_id, amount_cents, created_at) VALUES (?,?,?,?,?)").run(id, user.tenantId, orderId, d.amountCents, now());
        return { ...d, refundId: id };
      });
      return tx.immediate();
    },
  };
}

/** Conventional Express service: read order, request refund, get refund status. */
export function createOriginalApp(
  db: Database.Database,
  now: () => number,
  auth: (token: string | undefined) => User | null,
  refunds: RefundService = createLegacyRefundService(db, now),
) {
  const app = express();
  app.use(express.json());
  app.get("/orders/:id", (req, res) => {
    const user = auth(req.header("authorization")?.slice(7));
    if (!user) return res.status(401).end();
    const r = db.prepare("SELECT id, owner_id, tenant_id, refundable_cents FROM orders WHERE id=?").get(req.params.id) as any;
    if (!r || r.tenant_id !== user.tenantId || r.owner_id !== user.id) return res.status(404).end();
    res.json(r);
  });
  app.post("/refunds", async (req, res) => {
    const user = auth(req.header("authorization")?.slice(7));
    if (!user) return res.status(401).end();
    const { orderId, reason, message } = req.body ?? {};
    const key = req.header("idempotency-key");
    if (typeof orderId !== "string" || !REASONS.includes(reason) || !key) return res.status(400).end();
    const d = await refunds.requestRefund(user, { orderId, reason, message: typeof message === "string" ? message : undefined }, key);
    res.status(d.outcome === "ALLOW" ? 201 : d.outcome === "REVIEW" ? 202 : 422).json(d);
  });
  app.get("/refunds/:id", (req, res) => {
    const user = auth(req.header("authorization")?.slice(7));
    if (!user) return res.status(401).end();
    const r = db.prepare("SELECT * FROM refunds WHERE id=? AND tenant_id=?").get(req.params.id, user.tenantId);
    if (!r) return res.status(404).end();
    res.json(r);
  });
  return app;
}
