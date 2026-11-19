/**
 * Differential testing: run the ORIGINAL implementation and the MIGRATED one on identical
 * inputs and identical authoritative data (a fresh database seeded the same way for each side),
 * then compare what an observer can see.
 */
export type Observed = {
  /** ALLOW = the effect happened; REFUSE / REVIEW / CLARIFY = it did not; INVALID = input rejected. */
  outcome: "ALLOW" | "REFUSE" | "REVIEW" | "CLARIFY" | "INVALID" | "UNAUTHENTICATED";
  /** The application-level reason (the original's error code). */
  reason?: string | null;
  amount?: number | null;
  /** Normalised persistent state after the call (ids and timestamps removed). */
  state: unknown;
  /** Number of external calls made (after the dispatcher drained, for the migrated side). */
  external: number;
};

export type Mismatch<C> = { case: C; original: Observed; migrated: Observed; fields: string[] };
export type DiffReport<C> = { total: number; matches: number; mismatches: Mismatch<C>[]; byField: Record<string, number> };

export async function differential<C>(cases: C[], original: (c: C) => Promise<Observed>, migrated: (c: C) => Promise<Observed>): Promise<DiffReport<C>> {
  const report: DiffReport<C> = { total: cases.length, matches: 0, mismatches: [], byField: {} };
  for (const c of cases) {
    const o = await original(c);
    const m = await migrated(c);
    const fields = (["outcome", "reason", "amount", "state", "external"] as const).filter((k) => JSON.stringify(o[k] ?? null) !== JSON.stringify(m[k] ?? null));
    if (fields.length) {
      report.mismatches.push({ case: c, original: o, migrated: m, fields });
      for (const f of fields) report.byField[f] = (report.byField[f] ?? 0) + 1;
    } else report.matches++;
  }
  return report;
}
