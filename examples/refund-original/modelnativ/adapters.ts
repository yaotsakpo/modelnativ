// Completed from generated/adapters.scaffold.ts.txt.
import type Database from "better-sqlite3";
import { EffectRefusal, type EffectAdapter } from "@modelnativ/effect-executor";
import type { ReadTool } from "@modelnativ/runtime";

const DAY = 86_400_000;

export function tools(db: Database.Database, now: () => number): ReadTool[] {
  return [
    {
      name: "orders.get", // app.ts:20 loadOrder, now tenant-scoped
      async read(a) {
        const r = db.prepare("SELECT * FROM orders WHERE id = ? AND tenant_id = ?").get(a.id, a.tenant) as Record<string, number & string> | undefined;
        if (!r) return null;
        return {
          "order.id": r.id,
          "order.tenantId": r.tenant_id,
          "order.ownerId": r.owner_id,
          "order.ageDays": Math.floor((now() - (r.delivered_at ?? r.created_at)) / DAY),
          "order.refundableCents": r.refundable_cents,
          "order.version": r.version,
        };
      },
    },
    {
      name: "carrier.get", // app.ts:27
      async read(a) {
        const r = db.prepare("SELECT c.damaged, c.delivered FROM carrier_reports c JOIN orders o ON o.id = c.order_id WHERE c.order_id = ? AND o.tenant_id = ?").get(a.orderId, a.tenant) as { damaged: number | null; delivered: number | null } | undefined;
        if (!r) return null;
        const b = (x: number | null) => (x === null ? undefined : x === 1);
        return { "carrier.damaged": b(r.damaged), "carrier.delivered": b(r.delivered) };
      },
    },
  ];
}

export const refundRequestAdapter: EffectAdapter = {
  tool: "refund.request.apply",
  apply(db, args, binding, { effectId, now }) {
    const amount = Number(args.amountCents);
    // app.ts:32, now version-guarded against the version the decision saw
    const u = db.prepare("UPDATE orders SET refundable_cents = refundable_cents - ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ? AND refundable_cents >= ?").run(amount, args.orderId, binding.tenant, binding.expectedVersion, amount);
    if (u.changes !== 1) throw new EffectRefusal("STALE_STATE", "order changed since the decision");
    const id = effectId.replace(/^eff_/, "rf_");
    db.prepare("INSERT INTO refunds (id, tenant_id, order_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)").run(id, binding.tenant, args.orderId, amount, now); // app.ts:33
    return { result: { outcome: "ALLOW", amountCents: amount, refundId: id } };
  },
};
