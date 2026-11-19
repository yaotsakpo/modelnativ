import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { Ajv } from "@modelnativ/contract-schema/ajv";
import {
  canonicalJson as canonical,
  CONTRACT_JSON_SCHEMA,
  type Rule,
  type Contract,
  type DecisionCategory,
  type EffectSpec,
} from "@modelnativ/contract-schema";
import { ExprError, parseExpr, pathsOf, type Expr } from "./expr.ts";
import { conciseConstructsInExplicit, expandShorthand } from "./shorthand.ts";


export type CompiledCategory = DecisionCategory & { requiresExpr: Expr[] };

export type CompiledContract = {
  source: Contract;
  name: string;
  version: number;
  /** sha256 over the canonical JSON of the contract; pinned in every audit record. */
  hash: string;
  authorization: Expr[];
  /** Ordered, fact-only checks before the decision step (precedence preservation). */
  preconditions: Expr[];
  invariants: Expr[];
  categories: Record<string, CompiledCategory>;
  effects: Record<string, EffectSpec>;
  /** Every predicate some fact source provides. */
  predicates: Set<string>;
  /** JSON Schema for the model's proposal envelope. */
  proposalSchema: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
};

export class ContractError extends Error {
  constructor(public readonly problems: string[]) {
    super(`contract rejected:\n  - ${problems.join("\n  - ")}`);
  }
}

export type CompileOptions = {
  /** Read tools the runtime can actually call. Unknown fact tools are rejected. */
  readTools?: string[];
  /** Effect adapters the runtime can actually execute. Unknown effects are rejected. */
  effectTools?: string[];
};


function inScope(pred: string, scope: string[]): boolean {
  return scope.some((s) => (s.endsWith(".*") ? pred.startsWith(s.slice(0, -1)) : pred === s));
}

export function compileContract(rawDoc: unknown, opts: CompileOptions = {}): CompiledContract {
  // Concise contracts (kind: ConciseOperation) expand to the explicit contract first.
  // Everything below (validation, hash, runtime, docs) sees only the explicit form.
  const misplaced = conciseConstructsInExplicit(rawDoc as Record<string, any>);
  if (misplaced.length) throw new ContractError(misplaced);
  let doc: unknown;
  try {
    doc = expandShorthand(rawDoc as Record<string, any>);
  } catch (e) {
    throw new ContractError([`shorthand: ${(e as Error).message}`]);
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(CONTRACT_JSON_SCHEMA);
  if (!validate(doc)) {
    throw new ContractError(
      (validate.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`),
    );
  }
  const c = doc as Contract;
  const problems: string[] = [];

  // Input schema must itself be a valid JSON Schema.
  try {
    ajv.compile(c.spec.input);
  } catch (e) {
    problems.push(`spec.input is not a valid JSON Schema: ${(e as Error).message}`);
  }

  // ---- facts: tools exist, arguments reference earlier facts.
  const predicates = new Set<string>();
  const factTools = new Set<string>();
  for (const f of c.spec.facts) {
    if (f.tool !== "request" && opts.readTools && !opts.readTools.includes(f.tool))
      problems.push(`facts: unknown read tool "${f.tool}"`);
    for (const [arg, pred] of Object.entries(f.args ?? {}))
      if (!predicates.has(pred) && pred !== "principal.subject" && pred !== "principal.tenant")
        problems.push(`facts: ${f.tool}.${arg} reads "${pred}", which no earlier fact provides`);
    for (const p of f.provides) {
      if (predicates.has(p)) problems.push(`facts: "${p}" is provided twice`);
      predicates.add(p);
    }
    factTools.add(f.tool);
  }
  // Claims must target a predicate some OTHER source can establish; a claim alone is inert.
  for (const f of c.spec.facts)
    for (const p of f.claims ?? []) {
      if (!predicates.has(p)) problems.push(`facts: ${f.tool} claims "${p}", which no source provides`);
      if (f.provides.includes(p)) problems.push(`facts: ${f.tool} both provides and claims "${p}"`);
    }

  // ---- authority: channels exist; every fact can be established by its own channel.
  for (const g of c.spec.authority) {
    if (g.channel.startsWith("tool:") && !factTools.has(g.channel.slice(5)))
      problems.push(`authority ${g.id}: channel ${g.channel} is not a declared fact tool`);
    if (g.channel === "principal" && !factTools.has("request"))
      problems.push(`authority ${g.id}: principal channel granted but no request facts declared`);
  }
  const ids = c.spec.authority.map((g) => g.id);
  if (new Set(ids).size !== ids.length) problems.push("authority: duplicate grant ids");
  for (const f of c.spec.facts) {
    const channel = f.tool === "request" ? "principal" : `tool:${f.tool}`;
    for (const p of f.provides) {
      const covered = c.spec.authority.some((g) => g.channel === channel && inScope(p, g.predicates));
      if (!covered)
        problems.push(`facts: "${p}" comes from ${channel}, which holds no grant for it; it could never be established`);
    }
  }

  // ---- tenancy, concurrency, model context: every name must be a declared fact.
  if (!predicates.has(c.spec.tenancy.key)) problems.push(`tenancy.key "${c.spec.tenancy.key}" is not a declared fact`);
  const requestFacts = c.spec.facts.find((f) => f.tool === "request")?.provides ?? [];
  if (!requestFacts.includes(c.spec.concurrency.key))
    problems.push(`concurrency.key "${c.spec.concurrency.key}" must be a request fact (it is needed before any read)`);
  if (c.spec.concurrency.versionFact !== undefined && !predicates.has(c.spec.concurrency.versionFact))
    problems.push(`concurrency.versionFact "${c.spec.concurrency.versionFact}" is not a declared fact`);
  // ---- decision source: model (default), field, or hybrid.
  const source = c.spec.decision.source ?? { mode: "model" as const };
  if ((source.mode === "model" || source.mode === "hybrid") && !c.spec.model) problems.push(`spec.model is required for decision.source.mode "${source.mode}"`);
  for (const p of c.spec.model?.sees ?? [])
    if (!predicates.has(p)) problems.push(`model.sees: "${p}" is not a declared fact`);
  if (source.mode === "fact") {
    if (!source.field || !predicates.has(source.field)) problems.push(`decision.source.field must name a declared fact for mode "fact"`);
    if (!source.values) problems.push(`decision.source.values is required for mode "fact" (fact value -> category)`);
    for (const [v, cat] of Object.entries(source.values ?? {})) if (!c.spec.decision.categories[cat]) problems.push(`decision.source.values: "${v}" maps to unknown category "${cat}"`);
  }
  if (source.mode === "fixed") {
    if (!source.category || !c.spec.decision.categories[source.category]) problems.push(`decision.source.category must name a declared category for mode "fixed"`);
    if (source.field !== undefined || source.values !== undefined) problems.push(`decision.source: "fixed" takes a category, not a field`);
  }
  if (source.mode !== "model") {
    const reqFacts = c.spec.facts.find((f) => f.tool === "request")?.provides ?? [];
    const cats = Object.keys(c.spec.decision.categories);
    if (source.mode === "fixed" || source.mode === "fact") {
      /* checked above: no request field involved */
    } else if (!source.field) problems.push(`decision.source.field is required for mode "${source.mode}"`);
    else {
      if (!reqFacts.includes(source.field)) problems.push(`decision.source.field "${source.field}" must be a request fact (the caller's own statement)`);
      const prop = (c.spec.input as { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] }).properties?.[source.field.slice("request.".length)];
      const values = source.values ?? Object.fromEntries(cats.map((k) => [k, k]));
      for (const [ext, cat] of Object.entries(values)) if (!cats.includes(cat)) problems.push(`decision.source.values: "${ext}" maps to unknown category "${cat}"`);
      // Unknown categories must be rejected by input validation, before anything executes.
      if (!prop || prop.type !== "string" || !Array.isArray(prop.enum)) problems.push(`decision.source.field: spec.input must declare "${source.field.slice(8)}" as a string enum`);
      else {
        const keys = Object.keys(values).sort();
        if (JSON.stringify([...prop.enum].map(String).sort()) !== JSON.stringify(keys))
          problems.push(`decision.source.field: the input enum must equal the mapped values (${keys.join(", ")})`);
      }
      const required = (c.spec.input as { required?: string[] }).required ?? [];
      if (source.mode === "field" && !required.includes(source.field.slice(8))) problems.push(`decision.source.field must be required in spec.input for mode "field"`);
    }
    // The structured path builds the proposal from the contract: every established arg needs one source,
    // every bounded arg a default.
    for (const [tool, eff] of Object.entries(c.spec.effects))
      for (const [arg, spec] of Object.entries(eff.args)) {
        if (spec.authority === "established" && spec.from?.length !== 1) problems.push(`effects: ${tool}.${arg} needs exactly one "from" for a structured decision source`);
        if (spec.authority === "bounded" && !spec.default) problems.push(`effects: ${tool}.${arg} needs a "default" for a structured decision source`);
      }
    // Several effects: every category that can act must name its effect.
    if (Object.keys(c.spec.effects).length !== 1)
      for (const [name, cat] of Object.entries(c.spec.decision.categories))
        if (!cat.alwaysReview && !cat.effect) problems.push(`decision.${name}: name its effect (the contract declares several)`);
  }
  for (const [tool, eff] of Object.entries(c.spec.effects))
    for (const [arg, spec] of Object.entries(eff.args))
      if (spec.fromRequest !== undefined) {
        if (spec.authority !== "bounded") problems.push(`effects: ${tool}.${arg}: only bounded args take fromRequest`);
        const reqFacts = c.spec.facts.find((f) => f.tool === "request")?.provides ?? [];
        if (!reqFacts.includes(spec.fromRequest)) problems.push(`effects: ${tool}.${arg} fromRequest "${spec.fromRequest}" must be a request fact`);
      }

  // ---- effects.
  const proposalVars = new Set<string>();
  for (const [tool, eff] of Object.entries(c.spec.effects)) {
    if (opts.effectTools && !opts.effectTools.includes(tool)) problems.push(`effects: unknown effect "${tool}"`);
    for (const [arg, spec] of Object.entries(eff.args)) {
      proposalVars.add(`proposal.${arg}`);
      if (spec.authority === "established" && !spec.from?.length)
        problems.push(`effects: ${tool}.${arg} is "established" but names no "from" facts`);
      for (const p of spec.from ?? [])
        if (!predicates.has(p)) problems.push(`effects: ${tool}.${arg} from "${p}", which no fact provides`);
      if (spec.default !== undefined) {
        if (spec.authority !== "bounded") problems.push(`effects: ${tool}.${arg}: only bounded args take a default`);
        if (!predicates.has(spec.default)) problems.push(`effects: ${tool}.${arg} default "${spec.default}", which no fact provides`);
      }
    }
  }

  // ---- expressions: parse, then check every variable is defined in its context.
  const compileList = (where: string, list: Rule[], allowed: (p: string) => boolean): Expr[] =>
    list.flatMap((r) => {
      const src = typeof r === "string" ? r : r.rule;
      try {
        const e = parseExpr(src);
        if (typeof r !== "string") {
          if (r.description) e.description = r.description;
          if (r.code) e.code = r.code;
          if (r.unestablished) e.unestablished = r.unestablished;
        }
        for (const p of pathsOf(e)) if (!allowed(p)) problems.push(`${where}: undefined variable "${p}" in "${src}"`);
        return [e];
      } catch (err) {
        if (err instanceof ExprError) problems.push(`${where}: ${err.message}`);
        else throw err;
        return [];
      }
    });
  const factOrPrincipal = (p: string) =>
    predicates.has(p) || p === "principal.subject" || p === "principal.tenant";
  const authorization = compileList("policy.authorization", c.spec.policy.authorization, factOrPrincipal);
  const preconditions = compileList("policy.preconditions", c.spec.policy.preconditions ?? [], factOrPrincipal);
  const invariants = compileList(
    "policy.invariants",
    c.spec.policy.invariants,
    (p) => factOrPrincipal(p) || proposalVars.has(p),
  );
  const categories: Record<string, CompiledCategory> = {};
  for (const [name, cat] of Object.entries(c.spec.decision.categories)) {
    categories[name] = {
      ...cat,
      requiresExpr: compileList(`decision.${name}.requires`, cat.requires ?? [], factOrPrincipal),
    };
    if (!cat.alwaysReview && !(cat.requires ?? []).length)
      problems.push(`decision.${name}: a category that can authorize effects must require at least one fact`);
  }

  // ---- intent policy.
  const dec = c.spec.decision;
  if (dec.abstain !== undefined) {
    const a = dec.categories[dec.abstain];
    if (!a) problems.push(`decision.abstain "${dec.abstain}" is not a category`);
    else if (!a.alwaysReview) problems.push(`decision.abstain "${dec.abstain}" must be alwaysReview`);
  }
  const requestFactsAll = c.spec.facts.find((f) => f.tool === "request")?.provides ?? [];
  const evidenceFrom = dec.evidence ? (Array.isArray(dec.evidence.from) ? dec.evidence.from : [dec.evidence.from]) : [];
  if (dec.evidence) {
    for (const f of evidenceFrom) {
      if (!requestFactsAll.includes(f)) problems.push(`decision.evidence.from "${f}" must be a request fact (the caller's own words)`);
      if (!(c.spec.model?.sees ?? []).includes(f)) problems.push(`decision.evidence.from "${f}" must be in model.sees`);
    }
    if (dec.abstain === undefined) problems.push(`decision.evidence requires decision.abstain`);
  }
  // ---- clarification: optional; only intent can be clarified, and only by the caller's own words.
  const cl = c.spec.clarify;
  if (cl) {
    if (!dec.evidence) problems.push(`clarify requires decision.evidence (an intent policy)`);
    if (!requestFactsAll.includes(cl.field)) problems.push(`clarify.field "${cl.field}" must be a request fact`);
    if (!evidenceFrom.includes(cl.field)) problems.push(`clarify.field "${cl.field}" must be one of decision.evidence.from`);
    const prop = cl.field.slice("request.".length);
    const inputProps = (c.spec.input as { properties?: Record<string, { type?: string }> }).properties ?? {};
    if (inputProps[prop]?.type !== "string") problems.push(`clarify.field: spec.input must declare "${prop}" as a string`);
  }
  for (const [name, cat] of Object.entries(dec.categories))
    if (cat.intent && !dec.evidence) problems.push(`decision.${name}.intent requires decision.evidence`);

  for (const [name, cat] of Object.entries(c.spec.decision.categories))
    if (cat.effect !== undefined && !c.spec.effects[cat.effect]) problems.push(`decision.${name}.effect "${cat.effect}" is not a declared effect`);

  // ---- every bounded argument must have an upper bound in the invariants.
  for (const [tool, eff] of Object.entries(c.spec.effects))
    for (const [arg, spec] of Object.entries(eff.args)) {
      if (spec.authority !== "bounded") continue;
      const v = `proposal.${arg}`;
      const bounded = invariants.some(
        (e) =>
          (e.left.kind === "path" && e.left.path === v && (e.op === "<" || e.op === "<=")) ||
          (e.right.kind === "path" && e.right.path === v && (e.op === ">" || e.op === ">=")),
      );
      if (!bounded) problems.push(`effects: ${tool}.${arg} is "bounded" but no invariant bounds it from above`);
    }

  // ---- examples are documentation AND tests: their requests must satisfy the input schema.
  if (c.spec.examples?.length) {
    let validateInput: ((d: unknown) => boolean) | null = null;
    try {
      validateInput = ajv.compile(c.spec.input);
    } catch {
      /* already reported above */
    }
    for (const ex of c.spec.examples)
      if (validateInput && ex.expect.outcome !== "REFUSE" && !validateInput(ex.request))
        problems.push(`examples: "${ex.name}" request does not satisfy spec.input`);
  }

  if (problems.length) throw new ContractError(problems);

  return {
    source: c,
    name: c.metadata.name,
    version: c.metadata.version,
    hash: createHash("sha256").update(canonical(c)).digest("hex"),
    authorization,
    preconditions,
    invariants,
    categories,
    effects: c.spec.effects,
    predicates,
    proposalSchema: proposalSchemaFor(c, predicates),
    inputSchema: c.spec.input,
  };
}

function proposalSchemaFor(c: Contract, predicates: Set<string>): Record<string, unknown> {
  const effectVariants = Object.entries(c.spec.effects).map(([tool, eff]) => ({
    type: "object",
    additionalProperties: false,
    required: ["tool", "args"],
    properties: {
      tool: { const: tool },
      args: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(eff.args),
        properties: Object.fromEntries(
          Object.entries(eff.args).map(([arg, spec]) => [
            arg,
            {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["ref"],
                  properties: { ref: { enum: [...predicates] } },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["value"],
                  properties: { value: { type: spec.type } },
                },
              ],
            },
          ]),
        ),
      },
    },
  }));
  const intent = c.spec.decision.evidence
    ? {
        type: "object",
        additionalProperties: false,
        required: ["level", "evidence"],
        properties: {
          level: { enum: ["explicit", "implied", "ambiguous", "none"] },
          evidence: { type: "string", maxLength: 500 },
          confirmed: { type: "boolean" }, // set by the runtime; any model-supplied value is overwritten
        },
      }
    : null;
  const envelope = (decision: unknown, effects: unknown) => ({
    type: "object",
    additionalProperties: false,
    required: ["operation", "contractVersion", "decision", "category", "effects", ...(intent ? ["intent"] : [])],
    properties: {
      operation: { const: c.metadata.name },
      contractVersion: { type: "integer" },
      decision,
      category: { enum: Object.keys(c.spec.decision.categories) },
      effects,
      ...(intent ? { intent } : {}),
    },
  });
  // The effect count is tied to the decision, so constrained decoding cannot emit an
  // incoherent proposal (PROPOSE_EFFECT with no effect, REFUSE with one). Phase 0: one effect.
  return {
    oneOf: [
      envelope({ const: "PROPOSE_EFFECT" }, { type: "array", minItems: 1, maxItems: 1, items: { oneOf: effectVariants } }),
      envelope({ enum: ["REFUSE", "REVIEW"] }, { type: "array", maxItems: 0 }),
    ],
  };
}

export function loadContract(path: string, opts: CompileOptions = {}): CompiledContract {
  return compileContract(YAML.parse(readFileSync(path, "utf8")), opts);
}

/**
 * The fully explicit form of a compiled contract: every default the runtime applies is
 * written out, and every rule is normalised to { rule, description? }. This is what a
 * reviewer should read, what documentation is generated from, and what any future
 * shorthand must expand to. Pure function of the compiled contract.
 */
export function expandContract(c: CompiledContract): Record<string, unknown> {
  const src = c.source;
  const rule = (r: string | { rule: string; description?: string }) => (typeof r === "string" ? { rule: r } : r);
  const confirmList = (x: unknown) =>
    x === undefined ? [] : typeof x === "string" ? [{ ask: x, expect: "yes" }] : (x as unknown[]);
  return {
    apiVersion: src.apiVersion,
    kind: src.kind,
    metadata: src.metadata,
    hash: c.hash,
    spec: {
      ...src.spec,
      decision: {
        evaluation: src.spec.decision.evaluation ?? "all",
        source: {
          mode: src.spec.decision.source?.mode ?? "model",
          category: src.spec.decision.source?.category ?? null,
          field: src.spec.decision.source?.field ?? null,
          values: src.spec.decision.source && (src.spec.decision.source.mode === "field" || src.spec.decision.source.mode === "hybrid") ? src.spec.decision.source.values ?? Object.fromEntries(Object.keys(src.spec.decision.categories).map((k) => [k, k])) : null,
        },
        abstain: src.spec.decision.abstain ?? null,
        evidence: src.spec.decision.evidence ?? null,
        categories: Object.fromEntries(
          Object.entries(src.spec.decision.categories).map(([k, v]) => [
            k,
            {
              description: v.description,
              alwaysReview: v.alwaysReview ?? false,
              requires: (v.requires ?? []).map(rule),
              onUnestablished: v.onUnestablished ?? "review",
              intent: src.spec.decision.evidence ? { minimum: v.intent?.minimum ?? "implied", confirm: confirmList(v.intent?.confirm) } : null,
            },
          ]),
        ),
      },
      policy: {
        authorization: src.spec.policy.authorization.map(rule),
        preconditions: (src.spec.policy.preconditions ?? []).map(rule),
        invariants: src.spec.policy.invariants.map(rule),
      },
      // The runtime default applies when absent ("runtime" = configured settle mode, "release" unless configured).
      idempotency: { settle: src.spec.idempotency?.settle ?? "runtime default", retentionMs: src.spec.idempotency?.retentionMs ?? "runtime default" },
      reliability: {
        deadlineMs: src.spec.reliability?.deadlineMs ?? null,
        model: {
          perCallTimeoutMs: src.spec.model?.budget.timeoutMs ?? null,
          outputReasks: src.spec.model?.budget.maxRetries ?? null,
          retry: src.spec.reliability?.model?.retry ?? { maxAttempts: 1, baseMs: 0, maxMs: 0, jitter: "none" },
          breaker: src.spec.reliability?.model?.breaker ?? null,
        },
        tools: { timeoutMs: src.spec.reliability?.tools?.timeoutMs ?? null, retry: src.spec.reliability?.tools?.retry ?? { maxAttempts: 1, baseMs: 0, maxMs: 0, jitter: "none" } },
      },
      // Derived, not authored: what the kernel always enforces for this contract.
      enforced: {
        refusalOn: {
          authorizationFalse: "CAPABILITY_MISSING",
          invariantFalse: "INVARIANT_VIOLATION",
          tenantMismatch: "TENANT_VIOLATION",
          literalNotEstablished: "UNESTABLISHED_VALUE",
        },
        idempotency: "required, scoped to tenant + principal + operation",
        commit: "single transaction: idempotency record + adapter (version check) + outbox",
      },
    },
  };
}
