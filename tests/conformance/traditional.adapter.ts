/**
 * Conformance adapter for examples/refund-traditional. Goes through HTTP
 * (POST /v1/refunds on an ephemeral port) so authentication, validation and the
 * controller are exercised exactly as in production.
 */
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { seed } from "@modelnativ/example-refund-migrated";
import { createRefundSystem, JsonLinesAuditSink, SECRET_PAYMENT_API_KEY, SECRET_TOKEN_SIGNING_KEY } from "@modelnativ/example-refund-traditional";
import { InMemorySecretStore, ManualClock, SimulatedPaymentProvider } from "@modelnativ/example-refund-traditional/testing";
import type { Instance, Kind, RefundImpl } from "./types.ts";

const KIND_BY_STATUS: Record<number, Kind> = {
  201: "ALLOW",
  202: "REVIEW",
  422: "POLICY",
  400: "INVALID",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  503: "UNAVAILABLE",
};

export const traditionalImpl: RefundImpl = {
  name: "traditional",
  async create({ clockStart }): Promise<Instance> {
    const db = new Database(":memory:");
    seed(db, clockStart);
    const clock = new ManualClock(clockStart);
    const initialKey = "sk_live_initial_9f8e7d6c";
    const secrets = new InMemorySecretStore({ [SECRET_TOKEN_SIGNING_KEY]: "tok_signing_5b1d0c2e8a7f4e3d", [SECRET_PAYMENT_API_KEY]: initialKey });
    const provider = new SimulatedPaymentProvider(initialKey);
    const auditLines: string[] = [];
    const faults: { beforeCommit?: () => void; afterSend?: () => void } = {};
    const once = (slot: "beforeCommit" | "afterSend", message: string) => {
      faults[slot] = () => {
        faults[slot] = undefined;
        throw new Error(message);
      };
    };

    const system = createRefundSystem({ db, clock, secrets, provider, faults, audit: new JsonLinesAuditSink((l) => auditLines.push(l), clock) });
    const server = system.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/refunds`;

    return {
      token: (p) => system.tokens.issue(p),
      async submit({ token, body, key }) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        if (key) headers["idempotency-key"] = key;
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        const raw = (await res.json()) as { refundId?: string; amountCents?: number };
        return { kind: KIND_BY_STATUS[res.status] ?? "UNAVAILABLE", refundId: raw.refundId, amountCents: raw.amountCents, raw };
      },
      refundCount: () => (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n,
      balance: (orderId) => (db.prepare("SELECT refundable_cents AS c FROM orders WHERE id = ?").get(orderId) as { c: number }).c,
      outboxStatuses: () => (db.prepare("SELECT status FROM outbox ORDER BY id").all() as { status: string }[]).map((r) => r.status),
      drain: () => system.worker.drainOnce(),
      advance: (ms) => clock.advance(ms),
      provider: { payments: () => provider.paymentCount(), calls: () => provider.callCount(), failNext: (n) => provider.failNext(n) },
      faults: {
        crashAfterSendOnce: () => once("afterSend", "simulated worker crash after send"),
        failNextCommit: () => once("beforeCommit", "simulated commit failure"),
      },
      rotateSecret(value, providerAccepts) {
        secrets.set(SECRET_PAYMENT_API_KEY, value);
        if (providerAccepts) provider.acceptApiKey(value);
      },
      secretValues: () => secrets.all(),
      auditDump: () => auditLines.join("\n"),
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
      },
    };
  },
};
