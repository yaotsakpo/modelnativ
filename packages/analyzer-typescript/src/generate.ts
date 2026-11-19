/**
 * Migration generation for one business function: a candidate contract, adapter scaffolding,
 * and a migration report. Built on `inspect` + `extract`.
 *
 * Rules of the generator:
 *   - Never invent business rules, grants or requirements. What is derived from code is written
 *     with its source line; what cannot be derived is a `TODO` that fails compilation until a
 *     developer resolves it; what is derived but needs judgement carries `# REVIEW`.
 *   - Preserve observable behaviour by construction where possible: checks are emitted in the
 *     original order with `evaluation: sequential` / `policy.preconditions`, and each rule carries
 *     the original's reason code.
 */
import YAML from "yaml";
import type { FunctionInfo, Inventory, SqlUse } from "./inspect.ts";
import { extract, type Manifest } from "./extract.ts";

export type DecisionModeChoice = "auto" | "fixed" | "field" | "hybrid";

export type Generated = {
  contractYaml: string;
  adaptersTs: string;
  reportMd: string;
  manifest: Manifest & {
    inputSchema: unknown;
    principalParam: string | null;
    requestParam: string | null;
    outcomes: { status: string; reason?: string; mapsTo: string; line: number }[];
    precedence: { order: number; line: number; code?: string; rule?: string; kind: string }[];
    assumptions: { idempotency: string; concurrency: string; transaction: string };
    manualItems: string[];
  };
};

const TODO = "TODO";

function factName(local: string, col: string) {
  return `${local}.${col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

export function generateMigration(inv: Inventory, target: string, opts: { name: string; decision?: DecisionModeChoice; messageField?: string } = { name: "operation" }): Generated {
  const m = extract(inv, target);
  const byId = new Map(inv.functions.map((f) => [f.id, f]));
  const fns = m.functions.map((id) => byId.get(id)!);
  const root = fns[0]!;
  const manual: string[] = [];

  // ---- parameters: who is the caller, what is the request
  const isPrincipal = (p: FunctionInfo["params"][number]) =>
    /^(user|member|principal|caller|account|customer)$/i.test(p.name) ||
    (((p.schema as { properties?: Record<string, unknown> }).properties ?? {}).tenantId !== undefined && ((p.schema as { properties?: Record<string, unknown> }).properties ?? {}).id !== undefined);
  const principalParam = root.params.find(isPrincipal) ?? null;
  const requestParam = root.params.find((p) => p !== principalParam && (p.schema as { type?: string }).type === "object") ?? null;
  if (principalParam) manual.push(`Confirm "${principalParam.name}" is the authenticated caller (mapped to principal.subject / principal.tenant).`);
  else manual.push("No caller parameter recognised: identity must be mapped by hand.");
  const inputSchema = requestParam ? structuredClone(requestParam.schema) : { type: "object", additionalProperties: false, properties: {} };
  for (const n of requestParam?.schemaNotes ?? []) manual.push(`Input schema: ${n}`);
  const reqProps = Object.keys((inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  // destructured request params "{ orderId, reason }: RefundRequest"
  const reqName = requestParam?.name.startsWith("{") ? null : requestParam?.name;

  /** Map a source expression to a fact or principal path, or null. */
  const mapExpr = (e: string): string | null => {
    const t = e.trim();
    if (principalParam && !principalParam.name.startsWith("{")) {
      if (new RegExp(`^${principalParam.name}\\.(id|subject)$`).test(t)) return "principal.subject";
      if (new RegExp(`^${principalParam.name}\\.(tenantId|tenant)$`).test(t)) return "principal.tenant";
    }
    if (reqName && new RegExp(`^${reqName}\\.(\\w+)$`).test(t)) return `request.${t.split(".")[1]}`;
    if (reqProps.includes(t)) return `request.${t}`; // destructured
    return null;
  };

  // ---- fact sources from SELECTs
  type Tool = { name: string; sql: SqlUse; local: string; args: Record<string, string>; provides: string[]; fn: string };
  const tools: Tool[] = [];
  for (const fn of fns)
    for (const q of fn.sql.filter((x) => x.op === "SELECT")) {
      const local = q.assignedTo ?? q.tables[0]!;
      const args: Record<string, string> = {};
      q.boundArgs.forEach((a, i) => {
        const mapped = mapExpr(a);
        if (mapped) args[`arg${i}`] = mapped;
        else manual.push(`${q.file}:${q.line} read argument \`${a}\` is computed; compute it inside the read tool.`);
      });
      const cols = q.columns ?? [];
      if (!q.columns) manual.push(`${q.file}:${q.line} \`${q.text.slice(0, 40)}…\`: SELECT * or computed columns. List the facts this read provides.`);
      const provides = cols.map((c) => factName(local, c));
      if (/tenant/i.test(q.text)) provides.push(`${local}.tenantId`);
      tools.push({ name: `${q.tables[0]}.${local === q.tables[0] ? "get" : local}`.replace(/[^a-zA-Z0-9_.]/g, "_"), sql: q, local, args, provides, fn: fn.id });
    }

  // ---- outcomes (from return statements)
  const outcomes: Generated["manifest"]["outcomes"] = [];
  for (const fn of fns)
    for (const r of fn.returnsAt) {
      const status = r.fields.status ?? r.fields.outcome;
      if (!status || status.startsWith("<")) continue;
      const s = status.toLowerCase();
      const mapsTo = /allow|ok|success|redeemed|created|done|approved|refunded/.test(s) ? "ALLOW" : /review|pending|manual/.test(s) ? "REVIEW" : "REFUSE";
      outcomes.push({ status, reason: r.fields.reason, mapsTo, line: r.line });
    }

  // ---- rules in source order (precedence)
  const rewrite = (rule: string | undefined) => {
    if (!rule) return undefined;
    // Any bare identifier left (e.g. a computed local like `total`) is not a fact: do not emit a rule.
    const operands = rule.split(/\s+(?:==|!=|<=|>=|<|>)\s+/);
    if (operands.some((o) => /^[A-Za-z_$][\w$]*$/.test(o.trim()) && !/^(true|false)$/.test(o.trim()))) return undefined;
    let unknownRoot = false;
    const out = rule.replace(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g, (whole, a: string, b: string) => {
      const mapped = mapExpr(whole);
      if (mapped) return mapped;
      const tool = tools.find((t) => t.local === a);
      if (tool) return factName(a, b);
      // a param of a called function that receives a read (e.g. decideRefund(order)) keeps its name
      if (fns.some((f) => f !== root && f.params.some((p) => p.name === a))) return whole;
      unknownRoot = true; // a computed local (e.g. the result of a called function): not a fact
      return whole;
    });
    return unknownRoot ? undefined : out;
  };
  const precedence: Generated["manifest"]["precedence"] = [];
  const ruleItems = m.items.filter((i) => ["authorization", "invariant", "existence"].includes(i.kind)).sort((a, b) => (a.source.file === b.source.file ? a.source.line - b.source.line : 0));
  let order = 0;
  for (const it of ruleItems) {
    const reason = /reason:\s*"([^"]+)"/.exec(it.text)?.[1];
    precedence.push({ order: ++order, line: it.source.line, code: reason, rule: rewrite(it.candidateRule), kind: it.kind });
  }

  // ---- decision source
  const judgment = m.items.find((i) => i.kind === "judgment");
  let mode: Exclude<DecisionModeChoice, "auto"> = opts.decision && opts.decision !== "auto" ? opts.decision : judgment ? "field" : "fixed";
  const category = opts.name.split(".").pop()!.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const cases = judgment ? (/\{ (.*) \}/.exec(judgment.text)?.[1] ?? "").split(" | ").filter((c) => c !== "default").map((c) => c.replace(/["']/g, "")) : [];
  const enumField = judgment ? /switch \((\w+)/.exec(judgment.text)?.[1] : undefined;
  if (mode === "hybrid" && !opts.messageField) {
    manual.push("Hybrid mode needs a free-text field for the model; add one (e.g. message) to the input.");
  }

  // ---- assemble the contract document
  const ruleOf = (p: (typeof precedence)[number], it = ruleItems[p.order - 1]!) => {
    const rule = p.rule ?? `${TODO}: rewrite \`${it.text.replace(/^if \(/, "").split(")")[0]}\` as a comparison over facts`;
    if (!p.rule) manual.push(`${it.source.file}:${it.source.line} rule could not be translated: ${it.text.slice(0, 80)}`);
    const out: Record<string, unknown> = { rule };
    if (p.code) out.code = p.code;
    return out;
  };
  // existence checks become `unestablished` handling on the next rule about the same record
  const scopedBy = (it: (typeof ruleItems)[number]) => it.scope?.split("=")[1];
  const pending: { local: string; code?: string; outcome: string }[] = [];
  const pre: Record<string, unknown>[] = [];
  const authz: Record<string, unknown>[] = [];
  const perCase: Record<string, Record<string, unknown>[]> = Object.fromEntries(cases.map((c) => [c, []]));
  for (const p of precedence) {
    const it = ruleItems[p.order - 1]!;
    if (it.kind === "existence") {
      const local = /^!\s*([\w$]+)|([\w$]+)\??\.\w+\s*==\s*null/.exec(it.text.replace(/^if \(/, ""))?.slice(1).find(Boolean) ?? "?";
      const outcome = /REVIEW|review/.test(it.text) ? "review" : "refuse";
      pending.push({ local: tools.find((t) => t.local === local) ? local : local, code: p.code, outcome });
      continue;
    }
    const r = ruleOf(p, it);
    const hit = pending.findIndex((x) => String(r.rule).includes(`${x.local}.`));
    if (hit >= 0) {
      const x = pending.splice(hit, 1)[0]!;
      r.unestablished = { outcome: x.outcome, ...(x.code ? { code: x.code } : {}) };
    }
    const scope = scopedBy(it);
    if (it.kind === "authorization") authz.push(r);
    else if (scope && perCase[scope]) perCase[scope]!.push(r);
    else pre.push(r);
  }
  for (const x of pending) manual.push(`Existence check on "${x.local}" (${x.code ?? "no code"}) has no following rule about it; attach it to a rule or to tenancy.code.`);

  const firstLocal = tools.find((t) => t.args && Object.values(t.args).includes("principal.tenant"))?.local ?? tools[0]?.local;
  const doc: Record<string, unknown> = {
    apiVersion: "modelnativ.dev/v1alpha1",
    kind: "Operation",
    metadata: { name: opts.name, version: 1, summary: `Migrated from ${root.id} (${root.file}:${root.line})` },
    spec: {
      input: inputSchema,
      principal: { required: true, scopes: [`${opts.name.split(".")[0]}:${opts.name.split(".").pop()}`] },
      tenancy: { key: firstLocal ? `${firstLocal}.tenantId` : TODO, ...(pending.length || precedence.find((p) => p.kind === "existence") ? { code: precedence.find((p) => p.kind === "existence")?.code } : {}) },
      concurrency: { mode: "serialized_per_resource", key: reqProps[0] ? `request.${reqProps[0]}` : TODO, maxQueue: 1000 },
      facts: [{ tool: "request", provides: reqProps.map((p) => `request.${p}`) }, ...tools.map((t) => ({ tool: t.name, ...(Object.keys(t.args).length ? { args: t.args } : {}), provides: t.provides }))],
      authority: [{ id: "cap.request", channel: "principal", predicates: ["request.*"] }, ...tools.map((t) => ({ id: `cap.${t.name}`, channel: `tool:${t.name}`, predicates: [`${t.local}.*`] }))],
      decision: {
        ...(mode === "fixed" ? { source: { mode: "fixed", category } } : { source: { mode, field: `request.${enumField}` } }),
        evaluation: "sequential",
        categories:
          mode === "fixed"
            ? { [category]: { description: `The ${root.name} operation`, requires: pre.splice(0) } }
            : Object.fromEntries([...cases.map((c) => [c, { description: TODO, requires: perCase[c] ?? [] }]), ["OTHER", { description: "No establishable reason", alwaysReview: true }]]),
      },
      policy: { authorization: authz, preconditions: pre, invariants: [`${TODO}: bound every caller-supplied amount`] },
      effects: { [`${opts.name}.apply`]: { mode: "effectful", idempotency: "required", args: { [TODO]: { type: "string", authority: "established", from: [TODO] } } } },
      failure: { onUnverifiable: "refuse", onModelError: "refuse" },
    },
  };
  if (mode === "fixed") delete ((doc.spec as Record<string, unknown>).policy as Record<string, unknown>).preconditions;
  manual.push("Effects: name the effect arguments and their sources; the adapter scaffold lists the original writes.");
  manual.push("Invariants: bound every caller-supplied amount (the generator never invents limits).");
  manual.push("Authority grants are proposed from which tool reads which table: confirm each table is authoritative for those facts.");

  // ---- YAML with provenance comments
  let yaml = YAML.stringify(doc, { lineWidth: 0 });
  for (const p of precedence) if (p.rule) yaml = yaml.replace(`rule: ${p.rule}`, `rule: ${p.rule}   # from line ${p.line}`);
  yaml = yaml.replace(/(\n\s*- id: cap\.[^\n]+)/g, "$1   # REVIEW: confirm this source is authoritative");
  const header = [
    `# CANDIDATE CONTRACT generated by \`modelnativ extract\` from ${root.file}:${root.line}-${root.endLine}.`,
    `# Every TODO must be resolved before it compiles; every REVIEW needs a decision. Nothing here is trusted.`,
    `# Checks are in the original order (evaluation: sequential) with the original reason codes.`,
  ].join("\n");

  // ---- adapter scaffolding
  const writes = fns.flatMap((f) => f.sql.filter((q) => q.op !== "SELECT").map((q) => ({ q, f })));
  const http = fns.flatMap((f) => f.effects.map((e) => ({ e, f })));
  const adapters = [
    `// ADAPTER SCAFFOLD generated from ${root.file}. Reads become tools (facts minted on their own channel);`,
    `// writes become one effect adapter that runs inside the commit transaction. Complete every TODO.`,
    `import type Database from "better-sqlite3";`,
    `import type { EffectAdapter } from "@modelnativ/effect-executor";`,
    `import type { ReadTool } from "@modelnativ/runtime";`,
    ``,
    `export function tools(db: Database.Database): ReadTool[] {`,
    `  return [`,
    ...tools.map((t) =>
      [
        `    {`,
        `      name: ${JSON.stringify(t.name)}, // from ${t.sql.file}:${t.sql.line}`,
        `      async read(args) {`,
        `        const row = db.prepare(${JSON.stringify(t.sql.text)}).get(${t.sql.boundArgs.map((_, i) => `args.arg${i}`).join(", ")}) as Record<string, unknown> | undefined;`,
        `        if (!row) return null;`,
        `        return {`,
        ...(t.sql.columns ?? []).map((c) => `          ${JSON.stringify(factName(t.local, c))}: row[${JSON.stringify(c)}],`),
        ...(t.provides.includes(`${t.local}.tenantId`) ? [`          ${JSON.stringify(`${t.local}.tenantId`)}: args.arg${t.sql.boundArgs.length - 1}, // TODO: the tenant this row was read under`] : []),
        `        };`,
        `      },`,
        `    },`,
      ].join("\n"),
    ),
    `  ];`,
    `}`,
    ``,
    `export const effect: EffectAdapter = {`,
    `  tool: ${JSON.stringify(`${opts.name}.apply`)},`,
    `  apply(db, args, binding, { effectId, now }) {`,
    `    // TODO: re-check, inside the transaction, every fact the decision relied on (current state).`,
    ...writes.map(({ q }) => `    // ${q.file}:${q.line}\n    // TODO: guard this write (version check or a conditional WHERE) and check changes === 1\n    db.prepare(${JSON.stringify(q.text)}).run(/* TODO: ${q.boundArgs.join(", ")} */);`),
    `    return {`,
    `      result: { /* TODO: the fields the original returned on success */ },`,
    ...(http.length ? [`      // ${http.map(({ e }) => `${e.file}:${e.line} ${e.detail.slice(0, 60)}`).join("; ")}`, `      outbox: [{ destination: "TODO", payload: { /* TODO */ } }], // external call -> outbox (sent after commit, at-least-once)`] : []),
    `    };`,
    `  },`,
    `};`,
  ].join("\n");

  if (!/^Promise</.test(root.returns))
    manual.push(`${root.id} is synchronous (returns ${root.returns}); Modelnativ execution is async, so every caller must \`await\` the replacement.`);
  const assumptions = {
    idempotency: fns.some((f) => /idempot/i.test(f.sql.map((q) => q.text).join(" "))) ? "the original stores idempotency keys" : "NONE in the original: a retried request repeats the effect. Modelnativ requires an Idempotency-Key, so callers must send one.",
    concurrency: writes.some(({ q }) => /version/i.test(q.text)) ? "version-checked writes" : "NO version check in the original writes: concurrent requests rely on the transaction alone. The adapter must guard each write.",
    transaction: fns.some((f) => f.transaction) ? "the original wraps reads + writes in one transaction" : "NO transaction in the original",
  };
  if (http.length && fns.some((f) => f.transaction)) manual.push("The original makes an outbound call outside its transaction (fire-and-forget). The migration sends it via the outbox: delivery becomes at-least-once AFTER commit. This is an intended behaviour change; confirm it.");

  const report = [
    `# Migration report: ${root.id} -> ${opts.name}`,
    ``,
    `Source: ${root.file}:${root.line}-${root.endLine}; call graph: ${m.functions.join(" -> ")}`,
    `Decision source: **${mode}**${judgment ? ` (branch on caller-chosen \`${enumField}\`: ${cases.join(", ")})` : " (no model-suitable judgment: deterministic)"}`,
    ``,
    `## What was found`,
    `| Kind | Count |`,
    `|---|---|`,
    ...Object.entries(m.summary).map(([k, v]) => `| ${k} | ${v} |`),
    ``,
    `## Precedence (original order; first failure decides)`,
    `| # | Line | Kind | Code | Candidate rule |`,
    `|---|---|---|---|---|`,
    ...precedence.map((p) => `| ${p.order} | ${p.line} | ${p.kind} | ${p.code ?? ""} | ${p.rule ? `\`${p.rule}\`` : "**manual**"} |`),
    ``,
    `## Outcomes`,
    `| Original | Reason | Modelnativ |`,
    `|---|---|---|`,
    ...outcomes.map((o) => `| ${o.status} | ${o.reason ?? ""} | ${o.mapsTo}${o.reason ? ` (reason \`${o.reason}\`)` : ""} |`),
    ``,
    `## Assumptions in the original`,
    `- Idempotency: ${assumptions.idempotency}`,
    `- Concurrency: ${assumptions.concurrency}`,
    `- Transaction: ${assumptions.transaction}`,
    ``,
    `## Manual items (${manual.length})`,
    ...manual.map((x) => `- [ ] ${x}`),
    ``,
    `## Unsupported constructs`,
    ...(m.unsupported.length ? m.unsupported.map((u) => `- ${u.file}:${u.line} ${u.construct}: ${u.why}`) : ["- none"]),
    ...m.notes.map((n) => `\n> ${n}`),
  ].join("\n");

  return {
    contractYaml: `${header}\n${yaml}`,
    adaptersTs: adapters,
    reportMd: report,
    manifest: { ...m, inputSchema, principalParam: principalParam?.name ?? null, requestParam: requestParam?.name ?? null, outcomes, precedence, assumptions, manualItems: manual },
  };
}
