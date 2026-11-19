import type Database from "better-sqlite3";
import { scrub, type AuditSink } from "./audit.ts";
import { SECRET_PAYMENT_API_KEY, type Clock, type PaymentProvider, type SecretStore } from "./ports.ts";

export type OutboxWorkerOptions = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; batchSize: number };

/** Fault-injection hooks (no-ops in production). */
export type OutboxWorkerFaults = { afterSend?: () => void };

type OutboxRow = { id: number; idempotency_key: string; payload: string; attempts: number };

const DEFAULTS: OutboxWorkerOptions = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 5 * 60_000, batchSize: 50 };

/**
 * Delivers outbox messages to the payment provider at least once. The provider
 * dedupes on the message's idempotency key, so a redelivery after a crash
 * (sent but not yet marked delivered) never pays twice.
 */
export class OutboxWorker {
  private readonly opts: OutboxWorkerOptions;
  private readonly stmts;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    db: Database.Database,
    private readonly provider: PaymentProvider,
    private readonly secrets: SecretStore,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    private readonly faults: OutboxWorkerFaults = {},
    opts: Partial<OutboxWorkerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.stmts = {
      due: db.prepare<[number, number], OutboxRow>(
        "SELECT id, idempotency_key, payload, attempts FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
      ),
      delivered: db.prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ?"),
      retry: db.prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?"),
      dead: db.prepare("UPDATE outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?"),
    };
  }

  /** Processes every message that is due. Errors from the provider are handled; anything else propagates. */
  async drainOnce(): Promise<void> {
    for (const row of this.stmts.due.all(this.clock.now(), this.opts.batchSize)) await this.deliver(row);
  }

  start(intervalMs = 1_000): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.drainOnce()
        .catch((err) => this.audit.write({ event: "outbox.worker_error", outcome: "error", error: scrub(String(err), []) }))
        .finally(() => (this.running = false));
    }, intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const payload = JSON.parse(row.payload) as { refundId: string; orderId: string; amountCents: number };
    // Read at send time so a rotated key is picked up without a restart.
    const apiKey = this.secrets.get(SECRET_PAYMENT_API_KEY);
    try {
      await this.provider.createRefund({ ...payload, idempotencyKey: row.idempotency_key }, apiKey);
    } catch (err) {
      this.recordFailure(row, payload.refundId, scrub(err instanceof Error ? err.message : String(err), [apiKey]));
      return;
    }
    this.faults.afterSend?.();
    this.stmts.delivered.run(this.clock.now(), row.id);
    this.audit.write({ event: "payment.delivered", outcome: "delivered", refundId: payload.refundId, attempts: row.attempts + 1 });
  }

  private recordFailure(row: OutboxRow, refundId: string, error: string): void {
    const attempts = row.attempts + 1;
    if (attempts >= this.opts.maxAttempts) {
      this.stmts.dead.run(attempts, error, row.id);
      this.audit.write({ event: "payment.dead_lettered", outcome: "dead", refundId, attempts, error });
      return;
    }
    const delay = Math.min(this.opts.baseDelayMs * 2 ** (attempts - 1), this.opts.maxDelayMs);
    this.stmts.retry.run(attempts, this.clock.now() + delay, error, row.id);
    this.audit.write({ event: "payment.retry_scheduled", outcome: "retry", refundId, attempts, error });
  }
}
