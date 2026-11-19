/**
 * Generic application assembly: an app is a config module that names its contracts and
 * supplies its read tools, effect adapters and destinations. `serve`, `replay` and the
 * embedded SDK all build on this; nothing here knows about any particular domain.
 *
 *   // modelnativ.config.ts
 *   export default defineApp({
 *     contracts: ["contracts/refund.create.yaml"],
 *     tools: ({ db, env }) => [...],
 *     adapters: () => [...],
 *   });
 */
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import type Database from "better-sqlite3";
import { loadContract, type CompiledContract } from "@modelnativ/contract-compiler";
import { Dispatcher, Executor, MemorySecretStore, type Destination, type DispatcherOptions, type EffectAdapter, type SecretStore } from "@modelnativ/effect-executor";
import type { ModelAdapter } from "@modelnativ/model-adapter";
import { MemoryAudit, MemoryTraces, type AuditSink, type TraceStore } from "@modelnativ/observability";
import type { FairScheduler, Limiter } from "@modelnativ/reliability";
import { Engine, type EngineDeps, type ReadTool } from "./engine.ts";
import type { Env } from "./env.ts";
import { Identity } from "./identity.ts";

export type AppContext = { db: Database.Database; env: Env; secrets: SecretStore };

export type AppConfig = {
  /** Contract files, relative to the config file. */
  contracts: string[];
  tools: (ctx: AppContext) => ReadTool[];
  adapters: (ctx: AppContext) => EffectAdapter[];
  destinations?: (ctx: AppContext) => Destination[];
  /** Create the app's own tables (and, in dev, seed data). Called once on a fresh database. */
  setup?: (ctx: AppContext) => void;
  /**
   * For local demos only (`modelnativ serve --dev`): the identity the printed demo token carries,
   * and an example request body to print as a ready-to-run command. Never used for authorization.
   */
  demo?: { principal: { subject: string; tenant: string; scopes?: string[] }; operation?: string; request?: Record<string, unknown> };
};

/** Default bounds for the in-memory audit and trace stores createApp uses when none is given. */
export const DEFAULT_MEMORY_AUDIT = 10_000;
export const DEFAULT_MEMORY_TRACES = 1_000;

export function defineApp(c: AppConfig): AppConfig {
  return c;
}

export type BuiltApp = {
  engines: Engine[];
  contracts: CompiledContract[];
  executor: Executor;
  dispatcher: Dispatcher;
  identity: Identity;
  audit: AuditSink;
  traces: TraceStore;
  /** Every read tool name the app provides (for replay). */
  toolNames: string[];
};

export function createApp(
  config: AppConfig,
  configDir: string,
  opts: {
    env: Env;
    db: Database.Database;
    model?: ModelAdapter;
    secrets?: SecretStore;
    audit?: AuditSink;
    traces?: TraceStore;
    limiter?: Limiter;
    scheduler?: FairScheduler;
    dispatch?: DispatcherOptions;
    runSetup?: boolean;
    /** Engine options: per-resource queue, idempotency waiting/leases, observability hook. */
    engine?: Pick<EngineDeps, "serialize" | "idempotency" | "onObservabilityFailure">;
  },
): BuiltApp {
  // No secret store given: a RANDOM signing key for this process only. Tokens it issues are valid
  // only inside this process (tests, embedded use). There is no well-known default key.
  const secrets = opts.secrets ?? new MemorySecretStore({ "ingress.signingKey": randomBytes(32).toString("hex") });
  const ctx: AppContext = { db: opts.db, env: opts.env, secrets };
  if (opts.runSetup) config.setup?.(ctx);
  const tools = config.tools(ctx);
  const adapters = config.adapters(ctx);
  // Startup checks of adapters that can validate themselves (e.g. sqlEffect: every statement prepares).
  for (const a of adapters) (a as { validate?: (db: Database.Database) => void }).validate?.(opts.db);
  const executor = new Executor(opts.db, opts.env.clock, opts.env.faults, (p) => opts.env.random.id(p), adapters);
  const contracts = config.contracts.map((c) =>
    loadContract(isAbsolute(c) ? c : join(configDir, c), { readTools: tools.map((t) => t.name), effectTools: executor.tools }),
  );
  // Drift check: a tool that declares what it provides must provide every fact the contract expects of it.
  for (const c of contracts)
    for (const f of c.source.spec.facts) {
      const t = tools.find((x) => x.name === f.tool) as (ReadTool & { provides?: string[] }) | undefined;
      if (!t?.provides) continue;
      const missing = f.provides.filter((p) => !t.provides!.includes(p));
      if (missing.length) throw new Error(`${c.name}: tool ${f.tool} does not provide ${missing.join(", ")}`);
    }
  // Without explicit stores, audit and traces are kept in memory, BOUNDED (most recent only), so
  // an embedded app cannot grow without limit. This is not retention: pass a durable AuditSink /
  // TraceStore (e.g. FileAudit, DirTraces, or your own) when records must be kept.
  const audit = opts.audit ?? new MemoryAudit({ capacity: DEFAULT_MEMORY_AUDIT });
  const traces = opts.traces ?? new MemoryTraces({ capacity: DEFAULT_MEMORY_TRACES });
  const engines = contracts.map(
    (contract) =>
      new Engine({ env: opts.env, contract, model: opts.model, tools, executor, audit, traces, limiter: opts.limiter, scheduler: opts.scheduler, ...(opts.engine ?? {}) }),
  );
  const dispatcher = new Dispatcher(opts.db, opts.env.clock, opts.env.faults, secrets, config.destinations?.(ctx) ?? [], { random: opts.env.random, ...(opts.dispatch ?? {}) });
  return { engines, contracts, executor, dispatcher, identity: new Identity(secrets, () => opts.env.clock.now()), audit, traces, toolNames: tools.map((t) => t.name) };
}

/** Load `<dir>/modelnativ.config.ts` (or .js). */
export async function loadAppConfig(dir: string): Promise<{ config: AppConfig; dir: string }> {
  for (const f of ["modelnativ.config.ts", "modelnativ.config.js", "modelnativ.config.mjs"]) {
    const p = join(dir, f);
    try {
      const mod = (await import(p)) as { default?: AppConfig };
      if (mod.default) return { config: mod.default, dir: dirname(p) };
    } catch (e) {
      if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  throw new Error(`no modelnativ.config.ts in ${dir}`);
}
