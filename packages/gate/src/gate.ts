/**
 * The gate. Pure and deterministic: given a compiled contract, the authenticated
 * principal, the PSAP evidence for this operation and the model's raw proposal,
 * it returns ALLOW (with fully bound effects), REFUSE or REVIEW, with a stable code.
 *
 * Nothing the proposal says about authority is read. The proposal contributes
 * exactly three things: a decision, a category, and effect arguments, and each
 * argument is either resolved against established evidence or bounded by invariants.
 */
import AjvModule, { type ValidateFunction } from "ajv";
import { evaluate, type CompiledContract, type Expr } from "@modelnativ/contract-compiler";
import type { Principal, Proposal, RefusalCode, ReviewCode } from "@modelnativ/contract-schema";
import type { Evidence } from "./evidence.ts";

const Ajv = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;

export type BoundEffect = {
  tool: string;
  args: Record<string, string | number>;
  /** For each argument: where its value came from. */
  provenance: Record<string, { kind: "established"; predicate: string; assertionId: string } | { kind: "bounded" }>;
  binding: {
    operation: string;
    contractVersion: number;
    contractHash: string;
    principal: string;
    tenant: string;
    resourceKey: string;
    /** null when the contract declares no versionFact: the adapter must guard its writes itself. */
    expectedVersion: number | null;
  };
};

export type GateDecision =
  | { outcome: "ALLOW"; effects: BoundEffect[]; checks: string[] }
  | { outcome: "REFUSE"; code: RefusalCode; detail: string; checks: string[]; reason?: string }
  | { outcome: "REVIEW"; code: ReviewCode; detail: string; checks: string[]; reason?: string };

const validators = new WeakMap<CompiledContract, ValidateFunction>();
function proposalValidator(c: CompiledContract): ValidateFunction {
  let v = validators.get(c);
  if (!v) {
    v = new Ajv({ allErrors: false, strict: false }).compile(c.proposalSchema);
    validators.set(c, v);
  }
  return v;
}

/** Principal checks run before any model call (§21.1.1) and again inside evaluate(). */
export function checkPrincipal(
  contract: CompiledContract,
  principal: Principal | null,
  now: number = Date.now(),
): { code: RefusalCode; detail: string } | null {
  if (!principal || !principal.subject || !principal.tenant) return { code: "UNAUTHENTICATED", detail: "no authenticated principal" };
  if (principal.expiresAt <= now) return { code: "UNAUTHENTICATED", detail: "principal context expired" };
  const missing = contract.source.spec.principal.scopes.filter((s) => !principal.scopes.includes(s));
  if (missing.length) return { code: "CAPABILITY_MISSING", detail: `missing scope(s): ${missing.join(", ")}` };
  return null;
}

export function evaluateProposal(
  contract: CompiledContract,
  principal: Principal | null,
  evidence: Evidence,
  raw: unknown,
  now: number = Date.now(),
  /** Where the proposal came from, as decided by the RUNTIME (never read from the proposal). */
  opts: { source?: "model" | "field" } = {},
): GateDecision {
  const checks: string[] = [];
  // `reason` is the contract's application-level code for the rule that decided (if it declares one).
  const refuse = (code: RefusalCode, detail: string, reason?: string): GateDecision => ({ outcome: "REFUSE", code, detail, checks, ...(reason ? { reason } : {}) });
  const review = (code: ReviewCode, detail: string, reason?: string): GateDecision => ({ outcome: "REVIEW", code, detail, checks, ...(reason ? { reason } : {}) });

  // 1. Identity and operation scope, from the authenticated context only.
  const p = checkPrincipal(contract, principal, now);
  if (p) return refuse(p.code, p.detail);
  const who = principal!;
  if (evidence.principal.subject !== who.subject || evidence.principal.tenant !== who.tenant)
    return refuse("UNAUTHENTICATED", "evidence was gathered for a different principal");
  checks.push("principal:authenticated", "scopes:ok");

  // 2. Unknown effects are named as such before shape validation.
  if (raw && typeof raw === "object" && Array.isArray((raw as Proposal).effects)) {
    for (const e of (raw as Proposal).effects) {
      const tool = (e as { tool?: unknown })?.tool;
      if (typeof tool === "string" && !(tool in contract.effects))
        return refuse("UNSUPPORTED_EFFECT", `effect "${tool}" is not declared by ${contract.name}@${contract.version}`);
    }
  }

  const resolveFact = (path: string) => {
    if (path === "principal.subject") return { value: who.subject };
    if (path === "principal.tenant") return { value: who.tenant };
    const e = evidence.established(path);
    return e ? { value: e.value } : undefined;
  };

  /** Steps 4-5a: checks over facts only (no proposal involved). */
  const factChecks = (): GateDecision | null => {
    // 4. Tenancy: the resource must belong to the caller's tenant (defence in depth;
    //    tools are already tenant-scoped).
    const tenantKey = contract.source.spec.tenancy.key;
    const tenant = evidence.established(tenantKey);
    if (!tenant) return refuse("UNVERIFIABLE_PRECONDITION", `${tenantKey} is not established`, contract.source.spec.tenancy.code);
    if (tenant.value !== who.tenant) return refuse("TENANT_VIOLATION", `${tenantKey} does not match the caller's tenant`);
    checks.push("tenancy:ok");

    // 5. Resource-level authorization.
    for (const e of contract.authorization) {
      const r = evaluate(e, resolveFact);
      if (r.status === "unestablished") return refuse("UNVERIFIABLE_PRECONDITION", `${e.source}: not established: ${r.paths.join(", ")}`, e.unestablished?.code);
      if (r.status === "type_error") return refuse("UNVERIFIABLE_PRECONDITION", r.detail);
      if (r.status === "false") return refuse("CAPABILITY_MISSING", `authorization failed: ${e.source}`, e.code);
    }
    checks.push("authorization:ok");

    // 5a. Ordered, fact-only preconditions (declared per contract to preserve a legacy function's
    //     error precedence). The first rule that is not true decides. Absent: nothing runs here.
    for (const e of contract.preconditions) {
      const r = evaluate(e, resolveFact);
      if (r.status === "true") continue;
      if (r.status === "false") return refuse("INVARIANT_VIOLATION", `precondition failed: ${e.source}`, e.code);
      if (r.status === "type_error") return refuse("UNVERIFIABLE_PRECONDITION", r.detail, e.code);
      const u = e.unestablished ?? { outcome: "refuse" as const };
      return u.outcome === "review"
        ? review("UNESTABLISHED_REQUIREMENT", `precondition not established: ${e.source}`, u.code)
        : refuse("UNVERIFIABLE_PRECONDITION", `precondition not established: ${e.source}`, u.code);
    }
    if (contract.preconditions.length) checks.push("preconditions:ok");
    return null;
  };

  // A runtime-built (structured) proposal may depend on facts that earlier failures leave unset
  // (e.g. a routing fact); the fact checks run first so their codes keep the original precedence.
  if (opts.source === "field") {
    const f = factChecks();
    if (f) return f;
  }

  // 3. Shape.
  const validate = proposalValidator(contract);
  if (!validate(raw)) {
    const e = validate.errors?.[0];
    if (opts.source === "field") return refuse("UNVERIFIABLE_PRECONDITION", "the structured decision could not be derived from established facts");
    return refuse("SCHEMA_INVALID", `proposal ${e?.instancePath || "/"} ${e?.message ?? "invalid"}`);
  }
  const proposal = raw as Proposal;
  if (proposal.contractVersion !== contract.version)
    return refuse("CONTRACT_VERSION_MISMATCH", `proposal targets v${proposal.contractVersion}, contract is v${contract.version}`);
  checks.push("schema:ok");

  // 3a. A structured decision must be exactly what the contract derives from established facts:
  //     the caller's mapped field, a routing fact (mode "fact"), or the fixed category.
  //     The gate re-derives it from evidence instead of trusting whoever built the proposal.
  if (opts.source === "field") {
    const src = contract.source.spec.decision.source;
    let expected: string | undefined;
    if (src?.mode === "fixed") expected = src.category;
    else {
      const v = src?.field ? evidence.established(src.field)?.value : undefined;
      const values = src?.values ?? Object.fromEntries(Object.keys(contract.categories).map((k) => [k, k]));
      expected = typeof v === "string" ? values[v] : undefined;
    }
    if (!expected || proposal.category !== expected) return refuse("SCHEMA_INVALID", "structured decision does not match the caller's established field");
    checks.push(`source:field:${expected}`);
  } else {
    const f = factChecks();
    if (f) return f;
  }

  // 6. The model may always be more conservative, never less.
  if (proposal.decision === "REFUSE") {
    if (proposal.effects.length) return refuse("SCHEMA_INVALID", "REFUSE must not carry effects");
    return refuse("MODEL_DECLINED", `model declined (category ${proposal.category})`);
  }
  if (proposal.decision === "REVIEW") {
    if (proposal.effects.length) return refuse("SCHEMA_INVALID", "REVIEW must not carry effects");
    return review("MODEL_REQUESTED_REVIEW", `model requested review (category ${proposal.category})`);
  }
  if (proposal.effects.length !== 1)
    return refuse("SCHEMA_INVALID", "PROPOSE_EFFECT must carry exactly one effect (Phase 0)");

  // 7. The category selects which rule must hold; the rule is over established facts.
  const cat = contract.categories[proposal.category]!;
  if (cat.alwaysReview) return review("CATEGORY_REQUIRES_REVIEW", `category ${proposal.category} always goes to review`, cat.code);

  // 7a. Intent policy (contract-declared). Each check can only route to REVIEW: a model cannot
  //     select a category merely because it is permitted; it must report sufficient intent,
  //     ground it in the caller's own words, and pass the category's confirmation if declared.
  // The caller stated the category explicitly (field source): there is no interpretation to check.
  const policy = opts.source === "field" ? undefined : contract.source.spec.decision.evidence;
  if (policy) {
    const it = proposal.intent!;
    const min = cat.intent?.minimum ?? "implied";
    const rank = { explicit: 2, implied: 1, ambiguous: 0, none: 0 } as const;
    if (rank[it.level] < rank[min])
      return review("INTENT_NOT_ESTABLISHED", `category ${proposal.category} needs ${min} intent; model reported ${it.level}`);
    // Grounded = the quote appears in one of the caller's own established texts.
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
    const sources = (Array.isArray(policy.from) ? policy.from : [policy.from]).map((f) => evidence.established(f)?.value).filter((v): v is string => typeof v === "string");
    if (norm(it.evidence).length < 3 || !sources.some((t) => norm(t).includes(norm(it.evidence))))
      return review("INTENT_UNGROUNDED", `quoted evidence is not in ${String(policy.from)}`);
    if (cat.intent?.confirm && it.confirmed !== true)
      return review("INTENT_UNCONFIRMED", `category ${proposal.category}: confirmation not answered yes`);
    checks.push(`intent:${it.level}:grounded${cat.intent?.confirm ? ":confirmed" : ""}`);
  }
  if (contract.source.spec.decision.evaluation === "sequential") {
    // In declared order; the first rule that is not true decides (mirrors an if/return chain).
    for (const e of cat.requiresExpr) {
      const r = evaluate(e, resolveFact);
      if (r.status === "true") continue;
      if (r.status === "false") return refuse("INVARIANT_VIOLATION", `category ${proposal.category} requires ${e.source}`, e.code);
      if (r.status === "type_error") return refuse("UNVERIFIABLE_PRECONDITION", r.detail, e.code);
      const outcome = e.unestablished?.outcome ?? cat.onUnestablished ?? "review";
      return outcome === "review"
        ? review("UNESTABLISHED_REQUIREMENT", `category ${proposal.category}: not established by a channel with authority: ${e.source}`, e.unestablished?.code)
        : refuse("UNVERIFIABLE_PRECONDITION", `category ${proposal.category}: not established: ${e.source}`, e.unestablished?.code);
    }
  } else {
    const results = cat.requiresExpr.map((e) => ({ e, r: evaluate(e, resolveFact) }));
    const failed = results.find((x) => x.r.status === "false");
    if (failed) return refuse("INVARIANT_VIOLATION", `category ${proposal.category} requires ${failed.e.source}`, failed.e.code);
    const typeErr = results.find((x) => x.r.status === "type_error");
    if (typeErr && typeErr.r.status === "type_error") return refuse("UNVERIFIABLE_PRECONDITION", typeErr.r.detail);
    const unest = results.filter((x) => x.r.status === "unestablished");
    if (unest.length) {
      const what = unest.map((x) => x.e.source).join("; ");
      const first = unest[0]!.e;
      if ((first.unestablished?.outcome ?? cat.onUnestablished ?? "review") === "review")
        return review("UNESTABLISHED_REQUIREMENT", `category ${proposal.category}: not established by a channel with authority: ${what}`, first.unestablished?.code);
      return refuse("UNVERIFIABLE_PRECONDITION", `category ${proposal.category}: not established: ${what}`, first.unestablished?.code);
    }
  }
  checks.push(`category:${proposal.category}:requirements established`);

  // 8. Bind effect arguments. A category that names its effect accepts only that effect.
  const eff = proposal.effects[0]!;
  if (cat.effect && eff.tool !== cat.effect) return refuse("SCHEMA_INVALID", `category ${proposal.category} allows only effect ${cat.effect}`);
  const spec = contract.effects[eff.tool]!;
  const args: Record<string, string | number> = {};
  const provenance: BoundEffect["provenance"] = {};
  for (const [name, argSpec] of Object.entries(spec.args)) {
    const given = eff.args[name]!;
    if (argSpec.authority === "established") {
      const from = argSpec.from!;
      let hit: { predicate: string; value: unknown; assertionId: string } | undefined;
      if ("ref" in given) {
        if (!from.includes(given.ref))
          return refuse("UNESTABLISHED_VALUE", `${eff.tool}.${name} must come from ${from.join("|")}, not ${given.ref}`);
        const est = evidence.established(given.ref);
        if (est) hit = { predicate: given.ref, value: est.value, assertionId: est.assertionId };
      } else {
        // A literal typed by the model is minted on the agent channel (PROPOSING). It is
        // accepted only if it is EXACTLY a value a channel with authority established
        // (exact-string provenance, as in Inbin Gate); the bound value is the established one.
        for (const pred of from) evidence.record({ kind: "model" }, pred, given.value);
        for (const pred of from) {
          const est = evidence.established(pred);
          if (est && est.value === given.value) {
            hit = { predicate: pred, value: est.value, assertionId: est.assertionId };
            break;
          }
        }
      }
      if (!hit) return refuse("UNESTABLISHED_VALUE", `${eff.tool}.${name} is not a value established by a channel with authority`);
      if (typeof hit.value !== (argSpec.type === "integer" ? "number" : "string"))
        return refuse("UNVERIFIABLE_PRECONDITION", `${eff.tool}.${name}: established value has the wrong type`);
      args[name] = hit.value as string | number;
      provenance[name] = { kind: "established", predicate: hit.predicate, assertionId: hit.assertionId };
    } else {
      let v: unknown;
      if ("ref" in given) {
        const est = evidence.established(given.ref);
        if (!est) return refuse("UNVERIFIABLE_PRECONDITION", `${eff.tool}.${name} references ${given.ref}, which is not established`);
        v = est.value;
      } else v = given.value;
      if (argSpec.type === "integer" && !Number.isSafeInteger(v))
        return refuse("SCHEMA_INVALID", `${eff.tool}.${name} must be a safe integer`);
      if (argSpec.type === "string" && typeof v !== "string") return refuse("SCHEMA_INVALID", `${eff.tool}.${name} must be a string`);
      args[name] = v as string | number;
      provenance[name] = { kind: "bounded" };
    }
  }
  checks.push("arguments:bound");

  // 9. Invariants, with proposal.* bound to this effect's arguments.
  const resolveWithProposal = (path: string) => {
    if (path.startsWith("proposal.")) {
      const k = path.slice("proposal.".length);
      return k in args ? { value: args[k] } : undefined;
    }
    return resolveFact(path);
  };
  // An invariant about proposal.x applies to effects that have an argument x.
  const applicable = contract.invariants.filter((e) => [e.left, e.right].every((o) => o.kind !== "path" || !o.path.startsWith("proposal.") || o.path.slice(9) in args));
  const inv = checkAll(applicable, resolveWithProposal);
  if (inv) return inv.kind === "false" ? refuse("INVARIANT_VIOLATION", `invariant failed: ${inv.detail}`, inv.code) : refuse("UNVERIFIABLE_PRECONDITION", inv.detail, inv.code);
  checks.push("invariants:ok");

  // 10. Bind to operation, principal, resource and state version.
  const { key, versionFact } = contract.source.spec.concurrency;
  const resource = evidence.established(key);
  const version = versionFact ? evidence.established(versionFact) : null;
  if (!resource || typeof resource.value !== "string") return refuse("UNVERIFIABLE_PRECONDITION", `${key} is not established`);
  if (versionFact && (!version || !Number.isSafeInteger(version.value))) return refuse("UNVERIFIABLE_PRECONDITION", `${versionFact} is not established`);

  return {
    outcome: "ALLOW",
    checks,
    effects: [
      {
        tool: eff.tool,
        args,
        provenance,
        binding: {
          operation: contract.name,
          contractVersion: contract.version,
          contractHash: contract.hash,
          principal: who.subject,
          tenant: who.tenant,
          resourceKey: resource.value,
          expectedVersion: version ? (version.value as number) : null,
        },
      },
    ],
  };
}

function checkAll(
  exprs: Expr[],
  resolve: (p: string) => { value: unknown } | undefined,
): { kind: "false" | "unverifiable"; detail: string; code?: string } | null {
  for (const e of exprs) {
    const r = evaluate(e, resolve);
    if (r.status === "false") return { kind: "false", detail: e.source, code: e.code };
    if (r.status === "unestablished") return { kind: "unverifiable", detail: `${e.source}: not established: ${r.paths.join(", ")}`, code: e.unestablished?.code };
    if (r.status === "type_error") return { kind: "unverifiable", detail: r.detail, code: e.code };
  }
  return null;
}
