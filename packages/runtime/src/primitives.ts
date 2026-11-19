/**
 * Composable primitives for the two adapter patterns every migration repeated by hand
 * (recommended for new operations; hand-written adapters remain fully supported). Thin wrappers over better-sqlite3, plain TypeScript.
 *
 *   sqlRead    one parameterised SELECT -> facts. Column -> fact mapping is declared; derived
 *              facts are plain functions. Declares the facts it provides, so the app can check
 *              the contract against the tool (drift detection). Optional tenant guard.
 *   sqlEffect  an ordered list of steps run inside the commit transaction. Every write must
 *              say how many rows it expects and which refusal applies otherwise, so the
 *              "check changes === 1, throw" guard cannot be forgotten.
 *
 * They do not decide anything: rules stay in the contract and the gate.
 *
 * Startup checks (actionable errors, thrown when the tool or adapter is built):
 *   - every column a fact or `booleans` entry names must be a result column of the query
 *     (`stmt.columns()`, so aliases count; an unaliased expression must be aliased to be named);
 *   - a referenced column name returned twice (e.g. `id` from both sides of a JOIN) is ambiguous;
 *   - every SQL statement must prepare (typos in tables or columns fail at startup).
 *   If a table does not exist yet (schema created later by migrations), the same checks run
 *   on first use instead, with the same messages.
 */
import type Database from "better-sqlite3";
import type { RefusalCode } from "@modelnativ/contract-schema";
import { EffectRefusal, type EffectAdapter, type OutboxMessage } from "@modelnativ/effect-executor";
import type { BoundEffect } from "@modelnativ/gate";
import type { ReadTool } from "./engine.ts";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

export type SqlReadSpec = {
  name: string;
  sql: string;
  /** In placeholder order: a tool argument name, or a function computing the value (e.g. a time window). */
  params: (string | ((args: Args) => unknown))[];
  /** fact name -> column name, or a function deriving it from the row and the arguments. */
  facts: Record<string, string | ((row: Row, args: Args) => unknown)>;
  /**
   * The argument that must carry the caller's tenant. The SQL must use it (checked at
   * construction): a tenant-scoped read cannot silently become a cross-tenant read.
   */
  tenantParam?: string;
  /** Map SQLite booleans (0/1/null) to true/false/absent for these columns. */
  booleans?: string[];
  /**
   * Several facts from ONE computation per row (e.g. direction, proration and kind from the same
   * arithmetic). `compute` runs once per read; it must return only the declared facts. A missing,
   * null or undefined value leaves that fact absent, exactly as for single-fact functions.
   */
  derive?: { facts: string[]; compute: (row: Row, args: Args) => Record<string, unknown> }[];
};

/** Thrown for a primitive that cannot work as declared (bad SQL, unknown column, ambiguous name). */
export class PrimitiveConfigError extends Error {}

const missingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message));

function nearest(name: string, options: string[]): string | undefined {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i]![j] = Math.min(m[i - 1]![j]! + 1, m[i]![j - 1]! + 1, m[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length]![b.length]!;
  };
  const best = options.map((o) => [o, d(name.toLowerCase(), o.toLowerCase())] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(name.length / 3)) ? best[0] : undefined;
}

/** Check every column a spec references against what the prepared query actually returns. */
function checkColumns(spec: SqlReadSpec, stmt: Database.Statement) {
  const cols = stmt.columns();
  const names = cols.map((c) => c.name);
  const where = `sqlRead ${spec.name}`;
  const problems: string[] = [];
  const referenced: [string, string][] = [...Object.entries(spec.facts).filter((e): e is [string, string] => typeof e[1] === "string"), ...(spec.booleans ?? []).map((b) => [`booleans`, b] as [string, string])];
  for (const [fact, col] of referenced) {
    const n = names.filter((x) => x === col).length;
    if (n === 0) {
      const near = nearest(col, names);
      const expr = names.filter((x) => /[()\s*+-]/.test(x));
      problems.push(
        `${where}: ${fact === "booleans" ? "booleans entry" : `fact "${fact}" maps column`} "${col}", which the query does not return. Result columns: ${names.join(", ")}.` +
          (near ? ` Did you mean "${near}"?` : "") +
          (expr.length ? ` Unaliased expressions (${expr.join(", ")}) are named by their text: add "AS ${col}".` : ""),
      );
    } else if (n > 1) {
      const from = cols.filter((c) => c.name === col).map((c) => c.table ?? "an expression");
      problems.push(`${where}: column "${col}" is returned ${n} times (from ${from.join(", ")}); the row would keep only the last. Alias one of them (e.g. "s.${col} AS sub_${col}").`);
    }
  }
  if (problems.length) throw new PrimitiveConfigError(problems.join("\n"));
}

/**
 * Review metadata attached to every primitive: generated FROM the executable definition (the same
 * SQL strings, mappings and functions the runtime runs), so it cannot drift from the behaviour.
 * Function-valued parts are given as their source text (what a reviewer needs to see).
 */
export type PrimitiveReview =
  | { kind: "sqlRead"; sql: string; params: string[]; tenantParam?: string; facts: Record<string, { column: string; boolean?: true } | { derived: string }>; derive: { facts: string[]; source: string }[] }
  | { kind: "sqlEffect"; steps: { type: "write" | "insert" | "check"; sql: string; params: string; when?: string; expect?: number; assert?: string; refuse?: Refuse }[]; result: string; outbox?: string }
  | { kind: "config"; values: Record<string, string | number | boolean> };

export type DeclaredReadTool = ReadTool & { provides: string[]; review?: PrimitiveReview };

export function sqlRead(db: Database.Database, spec: SqlReadSpec): DeclaredReadTool {
  const placeholders = (spec.sql.match(/\?/g) ?? []).length;
  if (placeholders !== spec.params.length) throw new Error(`sqlRead ${spec.name}: ${placeholders} placeholders, ${spec.params.length} params`);
  if (spec.tenantParam && !spec.params.includes(spec.tenantParam)) throw new Error(`sqlRead ${spec.name}: tenantParam "${spec.tenantParam}" is not bound`);
  const derived = (spec.derive ?? []).flatMap((d) => d.facts);
  const provides = [...Object.keys(spec.facts), ...derived];
  const dup = provides.find((f, i) => provides.indexOf(f) !== i);
  if (dup) throw new PrimitiveConfigError(`sqlRead ${spec.name}: fact "${dup}" is declared twice (facts / derive)`);
  /** Prepared and checked once; deferred to first use only if a table does not exist yet. */
  let stmt: Database.Statement | null = null;
  const ready = () => {
    if (stmt) return stmt;
    let s: Database.Statement;
    try {
      s = db.prepare(spec.sql);
    } catch (e) {
      throw new PrimitiveConfigError(`sqlRead ${spec.name}: the query does not prepare: ${(e as Error).message}\n  ${spec.sql.replace(/\s+/g, " ").trim()}`);
    }
    checkColumns(spec, s);
    return (stmt = s);
  };
  try {
    ready();
  } catch (e) {
    if (!missingTable(e)) throw e; // schema not there yet: check on first read instead
  }
  const bools = new Set(spec.booleans ?? []);
  const review: PrimitiveReview = {
    kind: "sqlRead",
    sql: spec.sql.replace(/\s+/g, " ").trim(),
    params: spec.params.map((p) => (typeof p === "function" ? `(computed) ${p.toString()}` : p)),
    ...(spec.tenantParam ? { tenantParam: spec.tenantParam } : {}),
    facts: Object.fromEntries(Object.entries(spec.facts).map(([f, src]) => [f, typeof src === "function" ? { derived: src.toString() } : bools.has(src) ? { column: src, boolean: true as const } : { column: src }])),
    derive: (spec.derive ?? []).map((d) => ({ facts: d.facts, source: d.compute.toString() })),
  };
  return {
    name: spec.name,
    provides,
    review,
    async read(args) {
      const row = ready().get(...spec.params.map((p) => (typeof p === "function" ? p(args) : args[p]))) as Row | undefined;
      if (!row) return null;
      const out: Record<string, unknown> = {};
      for (const [fact, src] of Object.entries(spec.facts)) {
        let v = typeof src === "function" ? src(row, args) : row[src];
        if (typeof src === "string" && bools.has(src)) v = v === null || v === undefined ? undefined : v === 1 || v === true;
        if (v !== undefined && v !== null) out[fact] = v;
      }
      for (const d of spec.derive ?? []) {
        const values = d.compute(row, args);
        for (const k of Object.keys(values)) if (!d.facts.includes(k)) throw new PrimitiveConfigError(`sqlRead ${spec.name}: derive returned "${k}", which it does not declare (${d.facts.join(", ")})`);
        for (const f of d.facts) if (values[f] !== undefined && values[f] !== null) out[f] = values[f];
      }
      return out;
    },
  };
}

/**
 * Configuration values as established facts (e.g. thresholds and limits the original service
 * took as constructor config). The values stay in application config, the contract names
 * them (`policy.approvalThresholdCents`), the gate checks rules against them, and every
 * decision's evidence records the value that was in force.
 */
export function configFacts(name: string, facts: Record<string, string | number | boolean>): DeclaredReadTool {
  const values = { ...facts };
  return { name, provides: Object.keys(values), read: async () => ({ ...values }), review: { kind: "config", values: { ...values } } };
}

export type EffectCtx = { db: Database.Database; args: Record<string, string | number>; binding: BoundEffect["binding"]; effectId: string; now: number };
type Refuse = { code: RefusalCode; reason?: string; detail?: string };

/** Every step may carry `when`: it runs only if the predicate holds (e.g. "charge if positive"). */
type When = { when?: (c: EffectCtx) => boolean };
export type EffectStep = When &
  (
    /** A write that must affect exactly `expect` rows (default 1), else the refusal applies (rolled back). */
    | { write: string; params: (c: EffectCtx) => unknown[]; expect?: number; refuse: Refuse }
    /** A write whose row count does not matter (e.g. an INSERT that always succeeds). */
    | { insert: string; params: (c: EffectCtx) => unknown[] }
    /** A read-and-assert inside the transaction (re-check current state). */
    | { check: string; params: (c: EffectCtx) => unknown[]; assert: (row: Row | undefined, c: EffectCtx) => boolean; refuse: Refuse }
  );

export type SqlEffectSpec = {
  tool: string;
  steps: EffectStep[];
  result: (c: EffectCtx) => Record<string, unknown>;
  outbox?: (c: EffectCtx) => OutboxMessage[];
};

const stepSql = (s: EffectStep) => ("write" in s ? s.write : "insert" in s ? s.insert : s.check);

export function sqlEffect(spec: SqlEffectSpec): EffectAdapter & { validate(db: Database.Database): void; review: PrimitiveReview } {
  /** Prepared statements per connection, in step order (prepared once, not per commit). */
  const cache = new WeakMap<Database.Database, Database.Statement[]>();
  const prepared = (db: Database.Database) => {
    let st = cache.get(db);
    if (!st) {
      st = spec.steps.map((s, i) => {
        try {
          return db.prepare(stepSql(s));
        } catch (e) {
          throw new PrimitiveConfigError(`sqlEffect ${spec.tool}: step ${i + 1} does not prepare: ${(e as Error).message}\n  ${stepSql(s).replace(/\s+/g, " ").trim()}`);
        }
      });
      cache.set(db, st);
    }
    return st;
  };
  const review: PrimitiveReview = {
    kind: "sqlEffect",
    steps: spec.steps.map((s) => ({
      type: "write" in s ? ("write" as const) : "insert" in s ? ("insert" as const) : ("check" as const),
      sql: stepSql(s).replace(/\s+/g, " ").trim(),
      params: s.params.toString(),
      ...(s.when ? { when: s.when.toString() } : {}),
      ...("write" in s ? { expect: s.expect ?? 1, refuse: s.refuse } : {}),
      ...("check" in s ? { assert: s.assert.toString(), refuse: s.refuse } : {}),
    })),
    result: spec.result.toString(),
    ...(spec.outbox ? { outbox: spec.outbox.toString() } : {}),
  };
  return {
    tool: spec.tool,
    review,
    /** Startup check: every step's SQL prepares on this database (deferred if a table does not exist yet). */
    validate(db) {
      try {
        prepared(db);
      } catch (e) {
        if (!missingTable(e)) throw e;
      }
    },
    apply(db, args, binding, { effectId, now }) {
      const c: EffectCtx = { db, args, binding, effectId, now };
      const st = prepared(db);
      for (const [i, s] of spec.steps.entries()) {
        if (s.when && !s.when(c)) continue;
        if ("write" in s) {
          const r = st[i]!.run(...s.params(c));
          if (r.changes !== (s.expect ?? 1)) throw new EffectRefusal(s.refuse.code, s.refuse.detail ?? `expected ${s.expect ?? 1} row(s), changed ${r.changes}`, s.refuse.reason);
        } else if ("insert" in s) st[i]!.run(...s.params(c));
        else {
          const row = st[i]!.get(...s.params(c)) as Row | undefined;
          if (!s.assert(row, c)) throw new EffectRefusal(s.refuse.code, s.refuse.detail ?? "state changed since the decision", s.refuse.reason);
        }
      }
      return { result: spec.result(c), ...(spec.outbox ? { outbox: spec.outbox(c) } : {}) };
    },
  };
}
