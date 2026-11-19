/**
 * Duplicated business constants: a number compared in a contract rule that ALSO appears in a
 * comparison in adapter code (directly, or through a named constant). Such a pair drifts
 * silently: change one, and the other still decides (e.g. a daily limit checked by the gate
 * AND re-checked in the commit transaction).
 *
 * Heuristic, by design: it reads rule expressions and TypeScript text, not semantics. It reports
 * candidates with locations; a human decides. 0 and 1 are ignored (too common to mean anything).
 * The fix it points to: make the value one established fact (e.g. `policy.dailyLimit` from a
 * config read tool) and pass it to the adapter as an effect argument.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";

export type DuplicatedConstant = { value: string; rule: { file: string; path: string; expr: string }; code: { file: string; line: number; text: string } };

const CMP = "(?:<=|>=|<|>|===|!==|==|!=)";
const numberIn = (s: string) => [...s.matchAll(/(?<![\w.])(\d[\d_]*(?:\.\d+)?)(?![\w.])/g)].map((m) => m[1]!.replace(/_/g, ""));

function rules(doc: any): { path: string; expr: string }[] {
  const out: { path: string; expr: string }[] = [];
  const add = (path: string, list: unknown) => {
    for (const [i, r] of ((Array.isArray(list) ? list : []) as unknown[]).entries()) {
      const expr = typeof r === "string" ? r : r && typeof r === "object" ? ((r as { rule?: string }).rule ?? Object.keys(r as object)[0]) : undefined;
      if (typeof expr === "string") out.push({ path: `${path}[${i}]`, expr });
    }
  };
  const s = doc?.spec ?? {};
  for (const [n, c] of Object.entries((s.decision?.categories ?? {}) as Record<string, any>)) add(`spec.decision.categories.${n}.requires`, c?.requires);
  for (const k of ["authorization", "preconditions", "invariants"]) add(`spec.policy.${k}`, s.policy?.[k]);
  return out;
}

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "generated" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? files(p, ext) : n.endsWith(ext) ? [p] : [];
  });
}

/** Scan an app directory: contracts (*.yaml) against adapter code (*.ts). */
export function findDuplicatedConstants(appDir: string): DuplicatedConstant[] {
  const ruleNumbers = new Map<string, { file: string; path: string; expr: string }[]>();
  for (const f of files(appDir, ".yaml")) {
    let doc: unknown;
    try {
      doc = YAML.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const r of rules(doc))
      for (const v of numberIn(r.expr)) if (v !== "0" && v !== "1") ruleNumbers.set(v, [...(ruleNumbers.get(v) ?? []), { file: relative(appDir, f), ...r }]);
  }
  const found: DuplicatedConstant[] = [];
  for (const f of files(appDir, ".ts")) {
    const lines = readFileSync(f, "utf8").split("\n");
    // named constants: const NAME = <number>
    const named = new Map<string, string>();
    for (const l of lines) for (const m of l.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*(\d[\d_]*(?:\.\d+)?)\s*[;,]?/g)) named.set(m[1]!, m[2]!.replace(/_/g, ""));
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*)/.test(text)) return;
      const compared = new Set<string>();
      for (const m of text.matchAll(new RegExp(`${CMP}\\s*\\(?\\s*(\\d[\\d_]*(?:\\.\\d+)?)\\b|\\b(\\d[\\d_]*(?:\\.\\d+)?)\\s*\\)?\\s*${CMP}`, "g"))) compared.add((m[1] ?? m[2])!.replace(/_/g, ""));
      for (const [name, v] of named) if (new RegExp(`${CMP}\\s*${name}\\b|\\b${name}\\s*${CMP}`).test(text)) compared.add(v);
      for (const v of compared) for (const rule of ruleNumbers.get(v) ?? []) found.push({ value: v, rule, code: { file: relative(appDir, f), line: i + 1, text: text.trim() } });
    });
  }
  return found;
}

/**
 * Advisory: effectful contracts that do not declare their idempotency policy. Recommended for new
 * operations: `spec.idempotency: { settle: terminal }`. Existing contracts keep their behaviour
 * until they opt in; this only points them out.
 */
export function idempotencyRecommendations(appDir: string): { file: string; operation: string }[] {
  const out: { file: string; operation: string }[] = [];
  for (const f of files(appDir, ".yaml")) {
    let doc: any;
    try {
      doc = YAML.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (!doc || (doc.kind !== "Operation" && doc.kind !== "ConciseOperation") || !doc.spec?.effects) continue;
    if (doc.spec.idempotency?.settle === undefined) out.push({ file: relative(appDir, f), operation: String(doc.metadata?.name ?? "?") });
  }
  return out;
}
