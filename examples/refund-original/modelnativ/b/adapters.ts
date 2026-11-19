// Approach B: same explicit contract as A; adapters built from primitives.
import type Database from "better-sqlite3";
import { sqlEffect, sqlRead } from "@modelnativ/runtime";

const DAY = 86_400_000;

export const tools = (db: Database.Database, now: () => number) => [
  sqlRead(db, {
    name: "orders.get",
    sql: "SELECT * FROM orders WHERE id = ? AND tenant_id = ?",
    params: ["id", "tenant"],
    tenantParam: "tenant",
    facts: {
      "order.id": "id",
      "order.tenantId": "tenant_id",
      "order.ownerId": "owner_id",
      "order.ageDays": (r) => Math.floor((now() - Number(r.delivered_at ?? r.created_at)) / DAY),
      "order.refundableCents": "refundable_cents",
      "order.version": "version",
    },
  }),
  sqlRead(db, {
    name: "carrier.get",
    sql: "SELECT c.damaged, c.delivered FROM carrier_reports c JOIN orders o ON o.id = c.order_id WHERE c.order_id = ? AND o.tenant_id = ?",
    params: ["orderId", "tenant"],
    tenantParam: "tenant",
    booleans: ["damaged", "delivered"],
    facts: { "carrier.damaged": "damaged", "carrier.delivered": "delivered" },
  }),
];

export const refundRequestAdapter = sqlEffect({
  tool: "refund.request.apply",
  steps: [
    { write: "UPDATE orders SET refundable_cents = refundable_cents - ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ? AND refundable_cents >= ?", params: (c) => [c.args.amountCents, c.args.orderId, c.binding.tenant, c.binding.expectedVersion, c.args.amountCents], refuse: { code: "STALE_STATE" } },
    { insert: "INSERT INTO refunds (id, tenant_id, order_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)", params: (c) => [c.effectId.replace(/^eff_/, "rf_"), c.binding.tenant, c.args.orderId, c.args.amountCents, c.now] },
  ],
  result: (c) => ({ outcome: "ALLOW", amountCents: Number(c.args.amountCents), refundId: c.effectId.replace(/^eff_/, "rf_") }),
});
