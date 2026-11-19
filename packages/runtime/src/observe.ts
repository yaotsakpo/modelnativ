/**
 * Observed effect manifest: run an app's operations (e.g. its test cases) with every read tool and
 * effect adapter wrapped, and record which SQL each one actually executed, which tables it changed,
 * and which outbox destinations it emitted. Kernel bookkeeping (mn_*) is not the app's behaviour and
 * is excluded. This is EVIDENCE OF WHAT RAN on those inputs, not a proof of what can run.
 */
import type Database from "better-sqlite3";
import type { EffectAdapter } from "@modelnativ/effect-executor";
import type { AppConfig, AppContext } from "./app.ts";
import type { ReadTool } from "./engine.ts";

export type ObservedStatement = { sql: string; op: string; tables: string[]; count: number; rowsChanged: number };
export type ObservedManifest = {
  kind: "modelnativ.observed-effects";
  operation?: string;
  /** Fingerprint of the contract + primitive metadata the manifest was recorded against (staleness check). */
  fingerprint?: string;
  source: string;
  executions: number;
  reads: Record<string, ObservedStatement[]>;
  effects: Record<string, { applied: number; refused: Record<string, number>; statements: ObservedStatement[]; outbox: Record<string, number> }>;
};

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
export function sqlTables(sql: string): { op: string; tables: string[] } {
  const s = norm(sql);
  const op = (s.match(/^\s*(\w+)/)?.[1] ?? "?").toUpperCase();
  const tables = new Set<string>();
  for (const m of s.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w]*)/gi)) tables.add(m[1]!);
  return { op, tables: [...tables] };
}

export function withObservation(config: AppConfig, source: string): { config: AppConfig; manifest: ObservedManifest; countExecution: () => void } {
  const manifest: ObservedManifest = { kind: "modelnativ.observed-effects", source, executions: 0, reads: {}, effects: {} };
  let label: { kind: "read" | "effect"; name: string } | null = null;
  const record = (sql: string, changes: number) => {
    if (!label) return;
    const { op, tables } = sqlTables(sql);
    if (tables.some((t) => t.startsWith("mn_"))) return;
    const list = label.kind === "read" ? (manifest.reads[label.name] ??= []) : (manifest.effects[label.name] ??= { applied: 0, refused: {}, statements: [], outbox: {} }).statements;
    let e = list.find((x) => x.sql === norm(sql));
    if (!e) list.push((e = { sql: norm(sql), op, tables, count: 0, rowsChanged: 0 }));
    e.count++;
    e.rowsChanged += changes;
  };
  const wrapped = new WeakMap<Database.Database, Database.Database>();
  const observe = (db: Database.Database): Database.Database => {
    let w = wrapped.get(db);
    if (w) return w;
    w = new Proxy(db, {
      get(target, prop, recv) {
        if (prop !== "prepare") return Reflect.get(target, prop, recv);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(st, p, r) {
              const v = Reflect.get(st, p, r);
              if (p === "run") return (...a: unknown[]) => { const out = (v as (...x: unknown[]) => { changes: number }).apply(st, a); record(sql, out.changes); return out; };
              if (p === "get" || p === "all") return (...a: unknown[]) => { const out = (v as (...x: unknown[]) => unknown).apply(st, a); record(sql, 0); return out; };
              return typeof v === "function" ? v.bind(st) : v;
            },
          });
        };
      },
    });
    wrapped.set(db, w);
    return w;
  };
  const tools = (ctx: AppContext): ReadTool[] =>
    config.tools({ ...ctx, db: observe(ctx.db) }).map((t) =>
      Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
        read: async (args: Record<string, unknown>, c: unknown) => {
          const prev = label;
          label = { kind: "read", name: t.name };
          try {
            return await t.read(args, c as never);
          } finally {
            label = prev;
          }
        },
      }),
    );
  const adapters = (ctx: AppContext): EffectAdapter[] =>
    config.adapters({ ...ctx, db: observe(ctx.db) }).map((a) =>
      Object.assign(Object.create(Object.getPrototypeOf(a)), a, {
        apply: (db: Database.Database, args: Record<string, string | number>, binding: never, x: never) => {
          const prev = label;
          label = { kind: "effect", name: a.tool };
          const e = (manifest.effects[a.tool] ??= { applied: 0, refused: {}, statements: [], outbox: {} });
          try {
            const out = a.apply(observe(db), args, binding, x);
            e.applied++;
            for (const m of out.outbox ?? []) e.outbox[m.destination] = (e.outbox[m.destination] ?? 0) + 1;
            return out;
          } catch (err) {
            const k = `${(err as { code?: string }).code ?? "error"}${(err as { reason?: string }).reason ? `:${(err as { reason?: string }).reason}` : ""}`;
            e.refused[k] = (e.refused[k] ?? 0) + 1;
            throw err;
          } finally {
            label = prev;
          }
        },
      }),
    );
  return { config: { ...config, tools, adapters }, manifest, countExecution: () => void manifest.executions++ };
}
