/**
 * Function-level extraction (PRD §10 Classify / Extract / Evidence, §21.8).
 *
 * For one business function and everything it calls in the project, classify each piece
 * of behaviour, with the reason and source provenance:
 *
 *   authorization   ownership / tenancy / identity checks         -> stays deterministic
 *   invariant       thresholds and comparisons over state          -> deterministic rule
 *   existence       "not found" / null checks                      -> unverifiable precondition
 *   read            SQL reads                                      -> tenant-scoped read tool
 *   effect          SQL writes, outbound HTTP                      -> effect adapter (+ outbox)
 *   judgment        branch on a caller-chosen category             -> model candidate (intent)
 *   unknown         anything else                                  -> human review
 *
 * Nothing extracted is trusted: every item is `review: required` until a developer approves
 * it. The output is a manifest plus a DRAFT contract that is not compiled until reviewed.
 */
import type { Decision, FunctionInfo, Inventory, Loc } from "./inspect.ts";

export type ItemKind = "authorization" | "invariant" | "existence" | "read" | "effect" | "judgment" | "unknown";
export type ManifestItem = {
  id: string;
  /** Enclosing switch case ("reason=DAMAGED"): the rule applies only to that category. */
  scope?: string;
  kind: ItemKind;
  source: Loc & { function: string };
  text: string;
  why: string;
  confidence: "high" | "medium" | "low";
  review: "required";
  /** A candidate restricted expression (contract grammar), when one could be derived. */
  candidateRule?: string;
  warnings?: string[];
};

export type Manifest = {
  target: string;
  generatedFrom: Loc;
  functions: string[];
  items: ManifestItem[];
  summary: Record<ItemKind, number>;
  unsupported: Inventory["unsupported"];
  notes: string[];
};

const NEGATE: Record<string, string> = { ">": "<=", ">=": "<", "<": ">=", "<=": ">", "===": "!=", "==": "!=", "!==": "==", "!=": "==" };
const SIMPLE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(===|!==|==|!=|<=|>=|<|>)\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*$/;

/** Translate `if (a.b > 30) return refusal` into the requirement it implies: `a.b <= 30`. Constants are resolved. */
function requirementOf(cond: string, constants: Record<string, string> = {}): string | undefined {
  const m = SIMPLE.exec(cond);
  if (!m) return undefined;
  const [, l, op, r] = m;
  let rhs = r!.startsWith('"') ? `'${r!.slice(1, -1)}'` : r!;
  if (constants[rhs] !== undefined) rhs = constants[rhs]!;
  return `${l} ${NEGATE[op!]} ${rhs}`;
}

/** Is the condition about stored facts (params or values read from the database)? */
function rootsKnown(cond: string, fn: FunctionInfo): boolean {
  const roots = [...cond.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\??\./g)].map((x) => x[1]!);
  const known = new Set([...fn.params.flatMap((p) => [p.name, ...p.name.replace(/[{}\s]/g, "").split(",")]), ...fn.dbLocals, "this"]);
  return roots.every((r) => known.has(r));
}

function classifyDecision(d: Decision, fn: FunctionInfo, constants: Record<string, string>): Omit<ManifestItem, "id" | "source"> & { scope?: string } {
  const base = classifyDecisionRaw(d, fn, constants);
  if (d.kind === "if" && !rootsKnown(d.condition, fn) && base.kind !== "unknown")
    return { ...base, confidence: "low", warnings: [...(base.warnings ?? []), "Refers to a computed local value, not a stored fact or input: map it to a derived fact or keep it in an adapter."] };
  return { ...base, ...(d.kind === "if" && d.scope ? { scope: d.scope } : {}) };
}

function classifyDecisionRaw(d: Decision, fn: FunctionInfo, constants: Record<string, string>): Omit<ManifestItem, "id" | "source"> {
  const where = { function: fn.id };
  void where;
  if (d.kind === "switch") {
    const param = fn.params.find((p) => d.discriminant === p.name || d.discriminant.endsWith(`.${p.name}`) || d.discriminant === p.name);
    const literalUnion = param && /^("[^"]+"\s*\|\s*)+"[^"]+"$|^[A-Z]\w*$/.test(param.type);
    if (param && literalUnion)
      return {
        kind: "judgment",
        text: `switch (${d.discriminant}) { ${d.cases.join(" | ")} }`,
        why: `Branches on "${param.name}: ${param.type}", a category the CALLER chooses. In a model-native service this category can be inferred from the caller's own words, under an intent policy. The rules inside each case stay deterministic.`,
        confidence: "medium",
        review: "required",
      };
    return { kind: "unknown", text: `switch (${d.discriminant})`, why: "Switch over a value that is not a caller-chosen category; needs review.", confidence: "low", review: "required" };
  }
  const c = d.condition;
  const out = d.outcome;
  if (/\b(owner|ownerId|owner_id|tenant|tenantId|tenant_id|userId|subject)\b/.test(c) && /(!==|!=|===|==)/.test(c))
    return {
      kind: "authorization",
      text: `if (${c}) ${out}`,
      why: "Compares an ownership or tenancy field: an authorization rule. It must stay deterministic (gate + in-transaction re-check).",
      confidence: "high",
      review: "required",
      candidateRule: requirementOf(c, constants),
    };
  // `!flag.field` is a boolean fact that is false; `!record` (no dot) is a missing record.
  const neg = /^!\s*([\w$]+(?:\??\.[\w$]+)+)$/.exec(c.trim());
  if (neg) return { kind: "invariant", text: `if (${c}) ${out}`, why: "A boolean fact that must be true; deterministic.", confidence: "high", review: "required", candidateRule: `${neg[1]!.replace(/\?/g, "")} == true` };
  const pos = /^([\w$]+(?:\??\.[\w$]+)+)$/.exec(c.trim());
  if (pos) return { kind: "invariant", text: `if (${c}) ${out}`, why: "A boolean fact that must be false; deterministic.", confidence: "high", review: "required", candidateRule: `${pos[1]!.replace(/\?/g, "")} == false` };
  if (/^!\s*[\w$]+$/.test(c.trim()) || /(===|==)\s*(null|undefined)\b|\?\.\w+\s*==\s*null/.test(c))
    return {
      kind: "existence",
      text: `if (${c}) ${out}`,
      why: "A missing record or fact. In the contract this becomes an unestablished fact (UNVERIFIABLE_PRECONDITION or REVIEW), not a model decision.",
      confidence: "high",
      review: "required",
    };
  if (/(<=|>=|<|>)/.test(c))
    return {
      kind: "invariant",
      text: `if (${c}) ${out}`,
      why: "A threshold over stored or derived state (amounts, dates, counts, ranks). Arithmetic and limits stay deterministic.",
      confidence: requirementOf(c, constants) ? "high" : "medium",
      review: "required",
      candidateRule: requirementOf(c, constants),
      warnings: requirementOf(c, constants) ? undefined : ["The condition is not a single comparison of paths/literals; it must be rewritten by hand (or kept in an adapter)."],
    };
  if (/(===|==|!==|!=)/.test(c))
    return { kind: "invariant", text: `if (${c}) ${out}`, why: "An equality check on state; deterministic.", confidence: "medium", review: "required", candidateRule: requirementOf(c, constants) };
  return { kind: "unknown", text: `if (${c}) ${out}`, why: "Condition not recognised by the extractor; needs human review.", confidence: "low", review: "required" };
}

export function extract(inv: Inventory, target: string): Manifest {
  const byId = new Map(inv.functions.map((f) => [f.id, f]));
  const root = byId.get(target) ?? inv.functions.find((f) => f.name === target || f.id.endsWith(`.${target}`));
  if (!root) throw new Error(`function "${target}" not found; known: ${inv.functions.map((f) => f.id).join(", ")}`);

  // The target and everything it calls in the project (bounded depth).
  const seen = new Set<string>();
  const walk = (f: FunctionInfo, depth: number) => {
    if (seen.has(f.id) || depth > 4) return;
    seen.add(f.id);
    for (const c of f.calls) {
      const g = byId.get(c);
      if (g) walk(g, depth + 1);
    }
  };
  walk(root, 0);
  const fns = [...seen].map((id) => byId.get(id)!);

  const items: ManifestItem[] = [];
  let n = 0;
  const add = (fn: FunctionInfo, l: Loc, it: Omit<ManifestItem, "id" | "source">) => items.push({ id: `m${String(++n).padStart(3, "0")}`, source: { ...l, function: fn.id }, ...it });

  for (const fn of fns) {
    for (const s of fn.sql) {
      if (s.op === "SELECT") {
        const warnings = /tenant/i.test(s.text) ? undefined : ["No tenant filter found in this read. Tenancy must be established (e.g. via the owning record) before migration."];
        add(fn, s, { kind: "read", text: s.text, why: `Reads ${s.tables.join(", ")}: a fact source. It becomes a read tool whose results are minted on its own channel.`, confidence: "high", review: "required", warnings });
      } else
        add(fn, s, {
          kind: "effect",
          text: s.text,
          why: `${s.op} on ${s.tables.join(", ")}: a state transition. It stays deterministic in an effect adapter (version check, idempotency, one transaction).`,
          confidence: "high",
          review: "required",
          warnings: s.op === "UPDATE" && !/version/i.test(s.text) ? ["No optimistic version check in this write. Add one in the adapter (concurrent requests could lose updates)."] : undefined,
        });
    }
    for (const e of fn.effects)
      add(fn, e, { kind: "effect", text: e.detail, why: "Outbound call: an external effect. It must go through the outbox with an idempotency key (at-least-once, receiver de-duplicates).", confidence: "high", review: "required", warnings: fn.transaction ? ["Called next to a transaction: check it is not sent before the commit, and that it is retried if it fails after."] : undefined });
    for (const d of fn.decisions) add(fn, d, classifyDecision(d, fn, inv.constants));
  }

  const summary = { authorization: 0, invariant: 0, existence: 0, read: 0, effect: 0, judgment: 0, unknown: 0 } as Record<ItemKind, number>;
  for (const i of items) summary[i.kind]++;
  const notes: string[] = [];
  if (!summary.judgment)
    notes.push("No model-suitable judgment found: every decision here is deterministic. Migrating gains framework guarantees (idempotency, outbox, audit, replay) but no model role; consider keeping it conventional.");
  if (!fns.some((f) => f.transaction) && summary.effect) notes.push("Writes happen outside a transaction in the original; the migrated adapter must make them atomic.");
  return {
    target: root.id,
    generatedFrom: { file: root.file, line: root.line, endLine: root.endLine },
    functions: fns.map((f) => f.id),
    items,
    summary,
    unsupported: inv.unsupported.filter((u) => fns.some((f) => f.file === u.file && u.line >= f.line && u.line <= f.endLine)),
    notes,
  };
}

/** A DRAFT contract skeleton from a manifest. Not compiled until reviewed; every rule is commented with its source. */
export function draftContract(m: Manifest, name: string): string {
  const lines: string[] = [];
  const by = (k: ItemKind) => m.items.filter((i) => i.kind === k);
  lines.push(`# DRAFT generated by \`modelnativ extract\` from ${m.generatedFrom.file}:${m.generatedFrom.line}-${m.generatedFrom.endLine}.`);
  lines.push(`# Nothing here is trusted. Review every item (see the manifest), then remove this header to compile.`);
  lines.push(`apiVersion: modelnativ.dev/v1alpha1`, `kind: Operation`, `metadata:`, `  name: ${name}`, `  version: 1`, `spec:`);
  lines.push(`  # REVIEW: reads -> read tools (one per source); give each tool the facts it provides and a tenant scope.`);
  for (const r of by("read")) lines.push(`  #   ${r.id} ${r.source.file}:${r.source.line}  ${r.text}${r.warnings ? `   !! ${r.warnings[0]}` : ""}`);
  lines.push(`  policy:`, `    authorization:`);
  for (const a of by("authorization")) lines.push(`      - ${JSON.stringify(a.candidateRule ?? "TODO")}   # REVIEW ${a.id} ${a.source.file}:${a.source.line}  ${a.text}`);
  lines.push(`    invariants:`);
  for (const v of by("invariant").filter((x) => !x.scope)) lines.push(`      - ${JSON.stringify(v.candidateRule ?? "TODO")}   # REVIEW ${v.id} ${v.source.file}:${v.source.line}  ${v.text}${v.confidence === "low" ? "   !! low confidence" : ""}`);
  const j = by("judgment");
  if (j.length) {
    lines.push(`  # Model candidate: the caller-chosen category below can be inferred from free text under an intent policy.`);
    lines.push(`  decision:`, `    abstain: OTHER`, `    categories:`);
    for (const x of j) {
      const cases = /\{ (.*) \}/.exec(x.text)?.[1]?.split(" | ").filter((c) => c !== "default") ?? [];
      for (const c of cases) {
        const label = c.replace(/["']/g, "");
        const reqs = m.items.filter((i) => i.scope?.endsWith(`=${label}`) && i.candidateRule).map((i) => `${JSON.stringify(i.candidateRule)} # ${i.id} ${i.source.file}:${i.source.line}`);
        const unestablished = m.items.filter((i) => i.scope?.endsWith(`=${label}`) && i.kind === "existence").map((i) => `${i.id} ${i.source.file}:${i.source.line}`);
        lines.push(`      ${label}:   # REVIEW ${x.id} ${x.source.file}:${x.source.line}`, `        description: "TODO"`, `        requires:`);
        for (const r of reqs) lines.push(`          - ${r}`);
        if (unestablished.length) lines.push(`        onUnestablished: review   # from ${unestablished.join(", ")}`);
      }
    }
    lines.push(`      OTHER: { description: "No establishable reason", alwaysReview: true }`);
  } else lines.push(`  # No model-suitable judgment was found. See the manifest notes.`);
  lines.push(`  # REVIEW: effects -> adapters (writes in one transaction with a version check; outbound calls via the outbox).`);
  for (const e of by("effect")) lines.push(`  #   ${e.id} ${e.source.file}:${e.source.line}  ${e.text}${e.warnings ? `   !! ${e.warnings[0]}` : ""}`);
  for (const u of by("unknown")) lines.push(`  # UNKNOWN ${u.id} ${u.source.file}:${u.source.line}  ${u.text}`);
  return lines.join("\n") + "\n";
}
