import type { Clock } from "./ports.ts";

export type AuditRecord = { event: string; outcome: string; requestId?: string } & Record<string, unknown>;

export interface AuditSink {
  write(record: AuditRecord): void;
}

/** Writes one JSON line per record (to stdout, a file, or a log shipper). */
export class JsonLinesAuditSink implements AuditSink {
  constructor(
    private readonly out: (line: string) => void,
    private readonly clock: Clock,
  ) {}

  write(record: AuditRecord): void {
    this.out(JSON.stringify({ ts: new Date(this.clock.now()).toISOString(), ...record }));
  }
}

const SECRET_LIKE = /\b(?:sk|pk|rk|key)_[A-Za-z0-9_]{4,}\b/g;
const CARD_LIKE = /\b\d{12,19}\b/g;
const BEARER = /Bearer\s+\S+/gi;

/** Removes known secret values and secret-looking substrings from external text (e.g. provider errors). */
export function scrub(text: string, knownSecrets: string[]): string {
  let out = text;
  for (const s of knownSecrets) if (s) out = out.split(s).join("[REDACTED]");
  return out.replace(BEARER, "Bearer [REDACTED]").replace(SECRET_LIKE, "[REDACTED]").replace(CARD_LIKE, "[REDACTED]").slice(0, 500);
}
