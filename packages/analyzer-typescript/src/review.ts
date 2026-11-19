/**
 * `modelnativ review`: one view of an operation for a reviewer. Every behavioural statement is
 * labelled with WHERE its knowledge comes from:
 *   contract   the compiled contract (enforced by the gate)
 *   verified   primitive metadata, generated from the executable definition (cannot drift)
 *   static     heuristic extraction from the source text of hand-written code (may miss things)
 *   observed   recorded while running test cases (what ran on those inputs; not all that can run)
 *   declared   written by a developer, not checked (shown as UNVERIFIED)
 * Pure function over plain data: no runtime import (the CLI loads the app and passes it in).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type AnyRec = Record<string, any>;
export type ReviewInput = {
  contract: AnyRec; // explicit (expanded) contract document
  hash: string;
  concise: boolean;
  explain: string[]; // shorthand defaults/expansions applied
  tools: { name: string; provides?: string[]; review?: AnyRec; read?: Function; declared?: AnyRec }[];
  adapters: { tool: string; review?: AnyRec; apply?: Function; declared?: AnyRec }[];
  destinations: { name: string; send?: Function }[];
  observed?: AnyRec | null;
  runtime: { settleDefault: string; retentionMs: number; leaseMs: number; waitMs: number; maxWaiters: number; outbox: { maxAttempts: number; baseMs: number; maxMs: number; leaseMs: number } };
  tests: { file: string; titles: string[] }[];
  transient: string[];
};
export type Review = { text: string; detail: string; json: AnyRec };

const BUILTINS = new Set(["Number", "String", "Boolean", "Math", "Date", "JSON", "Object", "Array", "BigInt", "parseInt", "isFinite", "toISOString", "getTime", "replace", "slice", "map", "filter", "includes", "now", "iso", "p"]);
/** Functions a snippet calls, and CONSTANTS it reads, that are defined elsewhere (not shown). */
function externalCalls(src: string): string[] {
  const out = new Set<string>();
  // Bundlers rewrite imported functions as namespace members (e.g. vite: __vite_ssr_import_1__.fn(...)).
  src = src.replace(/\b__\w+__\./g, "").replace(/\(0,\s*[\w$]+\.(\w+)\)/g, "$1");
  for (const m of src.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) if (!BUILTINS.has(m[1]!) && !/^(if|for|while|return|new|async|await|function)$/.test(m[1]!)) out.add(`${m[1]}()`);
  for (const m of src.matchAll(/(?<![.\w'"])([A-Z][A-Z0-9_]{1,})(?![\w'"])/g)) out.add(m[1]!);
  return [...out];
}
const oneLine = (s: string, n = 110) => {
  const x = s.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
};
const tableOf = (sql: string) => sql.match(/\b(?:INTO|UPDATE|FROM)\s+([A-Za-z_]\w*)/i)?.[1] ?? "?";
function summarizeSql(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim();
  let m = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
  if (m) return `${m[1]}: SET ${m[2]}  WHERE ${m[3]}`;
  m = s.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (m) return `${m[1]} (${m[2]!.split(",").map((x) => x.trim()).join(", ")})`;
  m = s.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
  if (m) return `${m[1]}: DELETE WHERE ${m[2]}`;
  return oneLine(s, 120);
}
/** Static extraction from hand-written code: SQL literals, refusals, outbox destinations. */
function staticScan(fn?: Function) {
  const src = fn ? fn.toString() : "";
  const sql = [...src.matchAll(/prepare\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g)].map((m) => m[1]!.slice(1, -1).replace(/\s+/g, " ").trim());
  const refusals = [...src.matchAll(/EffectRefusal\(\s*"([A-Z_]+)"\s*,\s*"[^"]*"(?:\s*,\s*"([^"]+)")?/g)].map((m) => (m[2] ? `${m[1]}/${m[2]}` : m[1]!));
  const outbox = [...src.matchAll(/destination:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return { sql, refusals, outbox, calls: externalCalls(src) };
}
const ruleText = (r: AnyRec | string) => (typeof r === "string" ? r : r.rule);
const codeOf = (r: AnyRec | string, fallback: string) => (typeof r === "string" ? fallback : r.code ? r.code : fallback);

/**
 * What an observed manifest must have been recorded against: the contract hash and every
 * primitive's metadata (SQL, mappings, function sources). Hand-written code contributes its
 * source text. A manifest with another fingerprint describes different code: it is STALE.
 */
export function reviewFingerprint(hash: string, tools: { name: string; review?: unknown; read?: Function }[], adapters: { tool: string; review?: unknown; apply?: Function }[]): string {
  // Function sources differ by transform (tsx minifies, vite renames imports): normalise them.
  const canon = (x: unknown) => JSON.stringify(x ?? "").replace(/__\w+__\./g, "").replace(/\\n|\s+/g, "").replace(/;(?=[})\]])/g, "").replace(/\((\w+)\)=>/g, "$1=>");
  const parts = [hash, ...tools.map((t) => `${t.name}:${canon(t.review ?? t.read?.toString())}`), ...adapters.map((a) => `${a.tool}:${canon(a.review ?? a.apply?.toString())}`)].sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Test files that reference the app directory or the operation name, with their test titles. */
export function linkedTests(repoRoot: string, appDir: string, operation: string): { file: string; titles: string[] }[] {
  const rel = relative(repoRoot, appDir).replace(/\/c$|\/b$|\/a$/, "");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === "node_modules" ? [] : walk(join(d, n))) : n.endsWith(".test.ts") || n.endsWith(".lib.ts") ? [join(d, n)] : []));
  const out: { file: string; titles: string[] }[] = [];
  const base = rel.split("/").slice(-2).join("/"); // e.g. loyalty-original/modelnativ
  for (const f of walk(join(repoRoot, "tests"))) {
    const src = readFileSync(f, "utf8");
    if (!src.includes(base) && !src.includes(`"${operation}"`)) continue;
    const titles = [...src.matchAll(/\bit(?:\.fails)?\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]!);
    out.push({ file: relative(repoRoot, f), titles });
  }
  return out;
}

export function buildReview(i: ReviewInput): Review {
  const c = i.contract;
  const s = c.spec;
  const L: string[] = [];
  const D: string[] = [];
  const unverified: string[] = [];
  const json: AnyRec = { operation: c.metadata.name, version: c.metadata.version, hash: i.hash };
  const toolBy = new Map(i.tools.map((t) => [t.name, t]));
  const adapterBy = new Map(i.adapters.map((a) => [a.tool, a]));
  // Observed evidence counts only if it was recorded against THIS code (fingerprint match).
  const fp = reviewFingerprint(i.hash, i.tools, i.adapters);
  const stale = !!i.observed && i.observed.fingerprint !== fp;
  const obs = stale ? null : (i.observed ?? null);
  if (stale) unverified.push(`observed manifest is STALE (recorded against different code${i.observed?.fingerprint ? "" : "; no fingerprint"}): ignored; regenerate it`);
  json.fingerprint = fp;

  // ---- header, purpose, inputs
  L.push(`${c.metadata.name} v${c.metadata.version}  ${c.metadata.summary ?? ""}`);
  L.push(`  contract sha256:${i.hash.slice(0, 12)}…  ${i.concise ? `concise (${i.explain.length} defaults/expansions applied; --detail lists them)` : "explicit"}`);
  const props = (s.input?.properties ?? {}) as AnyRec;
  const req = new Set<string>(s.input?.required ?? []);
  const fmt = (n: string, p: AnyRec) => `${n}${req.has(n) ? "" : "?"}: ${p.type ?? "any"}${p.enum ? `{${p.enum.join("|")}}` : ""}${p.minimum !== undefined ? ` ≥${p.minimum}` : ""}${p.maxLength !== undefined ? ` ≤${p.maxLength} chars` : ""}`;
  L.push(`INPUT     ${Object.entries(props).map(([n, p]) => fmt(n, p as AnyRec)).join(", ")}`);
  json.input = props;

  // ---- authorization
  const principalArgs = (s.facts as AnyRec[]).filter((f) => Object.values(f.args ?? {}).some((v) => v === "principal.subject")).map((f) => f.tool);
  const auth = [`scope ${s.principal.scopes.join(", ")}`, `tenant: ${s.tenancy.key} must equal the caller's tenant${s.tenancy.code ? ` (else ${s.tenancy.code})` : ""}`];
  if (principalArgs.length) auth.push(`reads keyed by the caller (principal.subject): ${principalArgs.join(", ")}`);
  for (const r of s.policy.authorization ?? []) auth.push(`${ruleText(r)} → ${codeOf(r, "CAPABILITY_MISSING")}`);
  L.push(`WHO       ${auth.join("; ")}`);

  // ---- rules in evaluation order
  const src = s.decision.source ?? { mode: "model" };
  L.push(`DECIDES   ${src.mode === "fixed" ? `always category ${src.category}` : src.mode === "fact" ? `category from fact ${src.field} (${Object.entries(src.values).map(([k, v]) => `${k}→${v}`).join(", ")})` : src.mode === "field" ? `category from request field ${src.field}` : src.mode === "hybrid" ? `structured ${src.field} if given, else a MODEL proposal (gate-checked)` : "a MODEL proposal (gate-checked)"}`);
  if (s.model) {
    L.push(`MODEL     sees only: ${s.model.sees.join(", ")}; budget ${s.model.budget.timeoutMs} ms, ${s.model.budget.maxRetries} retry; it only PROPOSES a category, the rules below still decide`);
    unverified.push(`model interpretation of ${s.model.sees.join(", ")}: the gate checks the proposal against the rules, but not whether the model read the text correctly`);
  }
  L.push(`RULES     checked after WHO (tenancy, then authorization), in this order; ${s.decision.evaluation === "sequential" ? "the first failing rule decides" : "every rule must hold"}`);
  let n = 0;
  const rule = (r: AnyRec | string, code: string, where: string) => {
    const u = typeof r !== "string" && r.unestablished ? `; if unknown: ${r.unestablished.outcome}${r.unestablished.code ? ` ${r.unestablished.code}` : ""}` : "";
    L.push(`  ${String(++n).padStart(2)} ${oneLine(ruleText(r), 58).padEnd(58)} → ${code}${u}  ${where}`);
  };
  for (const r of s.policy.preconditions ?? []) rule(r, codeOf(r, "REFUSE"), "");
  for (const [name, cat] of Object.entries(s.decision.categories as Record<string, AnyRec>)) {
    if (cat.alwaysReview) {
      L.push(`  ${String(++n).padStart(2)} category ${name}: always REVIEW${cat.code ? ` (${cat.code})` : ""}`);
      continue;
    }
    for (const r of cat.requires ?? []) rule(r, codeOf(r, `REFUSE (${name})`), Object.keys(s.decision.categories).length > 1 ? `[${name}]` : "");
  }
  for (const r of s.policy.invariants ?? []) rule(r, codeOf(r, "INVARIANT_VIOLATION"), "[invariant]");

  // ---- data dependencies and derived values
  L.push(`READS`);
  const derived: string[] = [];
  for (const f of s.facts as AnyRec[]) {
    if (f.tool === "request") continue;
    const t = toolBy.get(f.tool);
    const rv = t?.review;
    const args = Object.entries(f.args ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
    const label = rv ? "verified" : "static";
    if (rv?.kind === "config") {
      L.push(`  ${f.tool.padEnd(20)} config values  [verified]`);
      for (const [k, v] of Object.entries(rv.values)) derived.push(`  ${k} = ${JSON.stringify(v)}  (app configuration)  [verified]`);
      continue;
    }
    if (rv?.kind === "sqlRead") {
      L.push(`  ${f.tool.padEnd(20)} ${tableOf(rv.sql)}${args ? ` (${args})` : ""}  [verified]`);
      D.push(`  ${f.tool}: ${rv.sql}\n      params: ${rv.params.join(", ")}`);
      for (const [fact, m] of Object.entries(rv.facts as AnyRec)) {
        if ("derived" in m) {
          derived.push(`  ${fact} = ${oneLine(m.derived, 90)}  [verified]`);
          const ext = externalCalls(m.derived);
          if (ext.length) unverified.push(`${fact}: uses ${ext.join(", ")} (defined in code; not shown)`);
        }
      }
      for (const d of rv.derive ?? []) {
        derived.push(`  ${d.facts.join(", ")} = ${oneLine(d.source, 90)}  [verified]`);
        const ext = externalCalls(d.source);
        if (ext.length) unverified.push(`${d.facts.join(", ")}: uses ${ext.join(", ")} (defined in code; not shown)`);
      }
      const computed = rv.params.filter((p: string) => p.startsWith("(computed)"));
      for (const p of computed) {
        derived.push(`  ${f.tool} parameter = ${oneLine(p.replace("(computed) ", ""), 80)}  [verified]`);
        const ext = externalCalls(p);
        if (ext.length) unverified.push(`${f.tool} parameter: uses ${ext.join(", ")} (defined in code; not shown)`);
      }
      continue;
    }
    const st = staticScan(t?.read);
    L.push(`  ${f.tool.padEnd(20)} ${st.sql.map(tableOf).join(", ") || "custom code"}${args ? ` (${args})` : ""}  [${label}]`);
    for (const q of st.sql) D.push(`  ${f.tool} (static): ${q}`);
    unverified.push(`read tool ${f.tool}: hand-written; facts ${f.provides.join(", ")} come from code that was only scanned, not analyzed`);
  }
  if (derived.length) L.push(`DERIVED   values computed outside the contract`, ...derived);
  json.derived = derived.map((d) => d.trim());

  // ---- mutations and sends, per effect
  const sends = new Map<string, string[]>();
  L.push(`CHANGES   one transaction per request: these writes + the effect record + the outbox, all or nothing`);
  for (const [effName, eff] of Object.entries(s.effects as Record<string, AnyRec>)) {
    const a = adapterBy.get(effName);
    const rv = a?.review;
    const o = obs?.effects?.[effName];
    const cats = Object.entries(s.decision.categories as Record<string, AnyRec>).filter(([, x]) => (x.effect ?? (Object.keys(s.effects).length === 1 ? effName : undefined)) === effName).map(([k]) => k);
    L.push(`  ${effName}${cats.length ? ` (when ${cats.join(" | ")})` : ""}  args: ${Object.entries(eff.args as Record<string, AnyRec>).map(([k, v]) => `${k}←${(v.from ?? [v.default ?? "?"]).join("|")}`).join(", ")}`);
    if (rv?.kind === "sqlEffect") {
      for (const st of rv.steps) {
        const seen = o ? o.statements.find((x: AnyRec) => x.sql === st.sql) : undefined;
        const tag = `[verified${o ? `; observed ${seen ? `${seen.count}×` : "NEVER"}` : ""}]`;
        const refuse = st.refuse ? `  else ${st.refuse.code}${st.refuse.reason ? `/${st.refuse.reason}` : ""}` : "";
        const when = st.when ? `  only if ${oneLine(st.when, 40)}` : "";
        const assert = st.assert ? `  require ${oneLine(st.assert, 50)}` : "";
        L.push(`    ${st.type.padEnd(6)} ${summarizeSql(st.sql)}${assert}${st.type === "write" ? ` (${st.expect} row)` : ""}${refuse}${when}  ${tag}`);
        if (o && !seen) unverified.push(`${effName}: step "${st.type} ${tableOf(st.sql)}" never ran in the observed executions`);
      }
      if (rv.outbox) for (const d of [...rv.outbox.matchAll(/destination:\s*"([^"]+)"/g)].map((m: RegExpMatchArray) => m[1]!)) sends.set(d, [...(sends.get(d) ?? []), effName]);
      for (const st of rv.steps) D.push(`  ${effName} ${st.type} ${tableOf(st.sql)}: ${st.sql}\n      values: ${oneLine(st.params, 220)}`);
      D.push(`  ${effName} result: ${oneLine(rv.result, 200)}`);
      if (rv.outbox) D.push(`  ${effName} outbox: ${oneLine(rv.outbox, 200)}`);
    } else {
      const st = staticScan(a?.apply);
      for (const q of st.sql) {
        const seen = o ? o.statements.find((x: AnyRec) => x.sql === q) : undefined;
        L.push(`    ${q.split(" ")[0]!.toLowerCase().padEnd(6)} ${summarizeSql(q)}  [static${o ? `; observed ${seen ? `${seen.count}×` : "NEVER"}` : ""}]`);
      }
      if (st.refusals.length) L.push(`    in-transaction refusals: ${st.refusals.join(", ")}  [static]`);
      for (const d of st.outbox) sends.set(d, [...(sends.get(d) ?? []), effName]);
      unverified.push(`adapter ${effName}: hand-written; writes above were extracted from source text (may be incomplete)`);
    }
    if (o) {
      const extra = o.statements.filter((x: AnyRec) => !(rv?.steps ?? []).some((st: AnyRec) => st.sql === x.sql) && !staticScan(a?.apply).sql.includes(x.sql));
      for (const x of extra) L.push(`    ${x.op.toLowerCase().padEnd(6)} ${summarizeSql(x.sql)}  [observed only ${x.count}×: not in the metadata]`);
      for (const d of Object.keys(o.outbox ?? {})) if (!sends.has(d)) sends.set(d, [effName]);
      if (!Object.keys(o.refused ?? {}).length && ((rv?.steps ?? []).some((st: AnyRec) => st.refuse) || staticScan(a?.apply).refusals.length))
        unverified.push(`${effName}: its in-transaction refusals (concurrent changes) never fired in the observed executions; covered only by concurrency tests, if any`);
    }
    if (a?.declared) {
      L.push(`    declared: ${oneLine(JSON.stringify(a.declared), 100)}  [UNVERIFIED]`);
      unverified.push(`${effName}: developer declaration is not checked`);
    }
  }
  const o = i.runtime.outbox;
  if (sends.size)
    for (const [d, effs] of sends) {
      const cnt = obs ? (Object.values(obs.effects ?? {}) as AnyRec[]).reduce((t: number, e) => t + Number(e.outbox?.[d] ?? 0), 0) : null;
      L.push(`SENDS     ${d} (from ${effs.join(", ")}): after commit via the outbox, at-least-once (receiver must de-duplicate by effect id), ${o.maxAttempts} attempts with backoff ${o.baseMs}–${o.maxMs} ms, then dead-letter${cnt !== null ? `  [observed ${cnt}×]` : ""}`);
      if (!i.destinations.some((x) => x.name === d)) unverified.push(`destination ${d} is not configured in this app`);
      else unverified.push(`destination ${d}: how it calls the external system is hand-written code (not shown)`);
    }
  else L.push(`SENDS     nothing (no outbox messages)`);

  // ---- idempotency, failures, defaults
  const idem = s.idempotency ?? {};
  const settle = idem.settle ?? `${i.runtime.settleDefault} (runtime default; not declared)`;
  L.push(`IDEMPOTENCY  key required; a retry with the same key returns the committed result; same key + other payload: REPLAY_DETECTED; after a refusal: ${settle === "terminal" ? "the same refusal (settled)" : `re-evaluated (settle: ${settle})`}; remembered ${Math.round((idem.retentionMs ?? i.runtime.retentionMs) / 86_400_000)} d; concurrent duplicates wait ≤ ${i.runtime.waitMs / 1000} s`);
  if (!idem.settle) unverified.push(`idempotency policy not declared in the contract (recommended for new operations: settle: terminal)`);
  const business = new Set<string>();
  for (const r of [...(s.policy.preconditions ?? []), ...(s.policy.authorization ?? []), ...Object.values(s.decision.categories as Record<string, AnyRec>).flatMap((x) => x.requires ?? []), ...(s.policy.invariants ?? [])]) if (typeof r !== "string" && r.code) business.add(r.code);
  const inTx = new Set<string>();
  for (const a of i.adapters) for (const st of a.review?.steps ?? []) if (st.refuse) inTx.add(`${st.refuse.reason ?? st.refuse.code}`);
  for (const a of i.adapters) if (!a.review) for (const r of staticScan(a.apply).refusals) inTx.add(r.split("/")[1] ?? r);
  L.push(`FAILURES  business (final): ${[...business].join(", ") || "-"}; at commit, if state changed meanwhile: ${[...inTx].join(", ") || "-"}; retryable: ${i.transient.filter((x) => x !== "IDEMPOTENCY_IN_PROGRESS").slice(0, 5).join(", ")}…; STALE_STATE is re-decided once on fresh state${s.reliability?.deadlineMs ? `; deadline ${s.reliability.deadlineMs} ms` : "; no deadline"}`);
  json.failures = { business: [...business], atCommit: [...inTx], retryable: i.transient };

  // ---- evidence
  const ev = i.tests.filter((t) => t.titles.length);
  L.push(`EVIDENCE  ${ev.length} test files reference this operation (${ev.reduce((x, t) => x + t.titles.length, 0)} tests)${obs ? `; observed manifest: ${obs.executions} executions (${obs.source})` : "; no observed manifest"}`);
  for (const t of ev.slice(0, 6)) L.push(`  ${t.file} (${t.titles.length})`);
  if (ev.length > 6) L.push(`  … ${ev.length - 6} more (--detail)`);
  for (const t of ev) D.push(`  ${t.file}:\n${t.titles.map((x) => `      - ${x}`).join("\n")}`);
  if (!obs) unverified.push(`no observed effect manifest: writes and sends are not confirmed by any recorded execution`);
  L.push(`  links are by reference (the test mentions this app or operation), not coverage`);

  // ---- unverified
  L.push(`NOT VERIFIED (${unverified.length})`, ...unverified.map((u) => `  ! ${u}`));
  json.unverified = unverified;

  const detail = [`DEFAULTS AND EXPANSIONS (${i.explain.length})`, ...i.explain.map((e) => `  ${e}`), `RUNTIME DEFAULTS`, `  lease ${i.runtime.leaseMs} ms, wait ≤ ${i.runtime.waitMs} ms, max waiters ${i.runtime.maxWaiters}, outbox lease ${o.leaseMs} ms`, `SQL AND SOURCES`, ...D].join("\n");
  return { text: L.join("\n"), detail, json };
}
