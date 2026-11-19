/**
 * Two records per operation, kept apart on purpose:
 *  - the AUDIT record: redacted, safe to ship to a log pipeline (PRD §6.G, §13);
 *  - the TRACE: everything needed to replay the operation deterministically
 *    (request, tool results, model decision, clock, ids). It contains customer
 *    data, so it is written only to a local trace store, never to the audit log.
 * Secret values never appear in either: the model context and the outbox carry
 * none, and the dispatcher scrubs adapter errors.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AuditRecord = {
  traceId: string;
  operationId: string;
  mode: "authoritative" | "shadow";
  at: number;
  operation: string;
  contractVersion: number;
  contractHash: string;
  modelId: string | null;
  /** "field" (structured, no model) or "model". */
  decisionSource?: "field" | "model";
  principal: string; // hashed
  tenant: string;
  input: { fields: string[]; messageSha256?: string; messageLength?: number };
  proposal: { decision?: string; category?: string; effectTools?: string[]; sha256?: string } | null;
  gate: { outcome: string; code?: string; detail?: string; checks: string[] };
  evidence: { id: string; predicate: string; class: string; via: string }[];
  effects: { effectId: string; tool: string; status: string; provenance: Record<string, unknown> }[];
  attempts: number;
  latency: { totalMs: number; modelMs: number };
  tokens: { prompt: number; completion: number };
};

export type TraceRecord = {
  traceId: string;
  runtimeVersion: string;
  contractHash: string;
  seed: number | null;
  clockStart: number;
  principal: unknown;
  request: { body: unknown; idempotencyKey: string | null };
  toolResults: { attempt: number; tool: string; args: Record<string, unknown>; result: unknown }[];
  model: { inputHash: string; modelId: string; output: unknown }[];
  /** Idempotency lookups in order (null = no prior effect). */
  lookups: (unknown | null)[];
  /** Per attempt: the effect the gate bound, and what the commit returned or threw. */
  commits: { attempt: number; effect: unknown; result?: unknown; error?: string }[];
  /** Durable idempotency-key decisions in order (claim / peek results). Absent in older traces. */
  claims?: unknown[];
  outcome: unknown;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashPrincipal = (subject: string) => `sha256:${sha256(`principal:${subject}`).slice(0, 16)}`;

export interface AuditSink {
  write(r: AuditRecord): void;
}
/**
 * In-memory audit. With `capacity`, keeps the most recent records (trimmed in batches, so at
 * most capacity + 10% are held) and counts what it dropped. NOT a retention store: dropped
 * records are gone. For retention use a durable sink (FileAudit, or your own AuditSink).
 */
export class MemoryAudit implements AuditSink {
  readonly records: AuditRecord[] = [];
  /** Records evicted to stay within capacity. */
  dropped = 0;
  constructor(readonly opts: { capacity?: number } = {}) {}
  write(r: AuditRecord) {
    this.records.push(r);
    const cap = this.opts.capacity;
    if (cap !== undefined && this.records.length >= cap + Math.max(1, Math.ceil(cap / 10))) {
      const n = this.records.length - cap;
      this.records.splice(0, n);
      this.dropped += n;
    }
  }
}
export class FileAudit implements AuditSink {
  constructor(private path: string) {}
  write(r: AuditRecord) {
    appendFileSync(this.path, JSON.stringify(r) + "\n");
  }
}

export interface TraceStore {
  put(t: TraceRecord): void;
  get(traceId: string): TraceRecord | undefined;
}
/** In-memory traces. With `capacity`, keeps the most recent traces and counts evictions. */
export class MemoryTraces implements TraceStore {
  readonly traces = new Map<string, TraceRecord>();
  dropped = 0;
  constructor(readonly opts: { capacity?: number } = {}) {}
  put(t: TraceRecord) {
    this.traces.set(t.traceId, t);
    const cap = this.opts.capacity;
    if (cap !== undefined)
      while (this.traces.size > cap) {
        this.traces.delete(this.traces.keys().next().value!);
        this.dropped++;
      }
  }
  get(id: string) {
    return this.traces.get(id);
  }
}
export class DirTraces implements TraceStore {
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  put(t: TraceRecord) {
    writeFileSync(join(this.dir, `${t.traceId}.json`), JSON.stringify(t, null, 2), { mode: 0o600 });
  }
  get(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    const p = join(this.dir, `${id}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as TraceRecord) : undefined;
  }
  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  }
}
