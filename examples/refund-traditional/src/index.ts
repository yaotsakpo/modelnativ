import type Database from "better-sqlite3";
import { createApp } from "./app.ts";
import type { AuditSink } from "./audit.ts";
import { TokenService } from "./auth.ts";
import { OutboxWorker, type OutboxWorkerFaults, type OutboxWorkerOptions } from "./outbox-worker.ts";
import type { Clock, PaymentProvider, SecretStore } from "./ports.ts";
import { RefundService, type RefundServiceFaults } from "./refund-service.ts";
import { migrate } from "./schema.ts";

export * from "./app.ts";
export * from "./audit.ts";
export * from "./auth.ts";
export * from "./outbox-worker.ts";
export * from "./policy.ts";
export * from "./ports.ts";
export * from "./refund-service.ts";
export * from "./schema.ts";
export * from "./validation.ts";

export type RefundSystemDeps = {
  db: Database.Database;
  clock: Clock;
  secrets: SecretStore;
  provider: PaymentProvider;
  audit: AuditSink;
  faults?: RefundServiceFaults & OutboxWorkerFaults;
  worker?: Partial<OutboxWorkerOptions>;
};

/** Composition root: wires the service, the HTTP app and the outbox worker. */
export function createRefundSystem(deps: RefundSystemDeps) {
  migrate(deps.db);
  const tokens = new TokenService(deps.secrets, deps.clock);
  const refunds = new RefundService(deps.db, deps.clock, deps.audit, deps.faults);
  const worker = new OutboxWorker(deps.db, deps.provider, deps.secrets, deps.clock, deps.audit, deps.faults, deps.worker);
  const app = createApp({ tokens, refunds, audit: deps.audit });
  return { tokens, refunds, worker, app };
}
