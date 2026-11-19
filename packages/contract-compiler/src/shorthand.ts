/**
 * Concise contracts (`kind: ConciseOperation`), expanded into the explicit contract
 * (`kind: Operation`) BEFORE validation. The expanded document is what is validated, hashed,
 * run and documented (`modelnativ compile --expanded`), so shorthand never changes semantics.
 * Reference: docs/concise-contracts.md. `explainShorthand` lists every default and expansion.
 *
 * Activation is explicit: only `kind: ConciseOperation` is expanded. A `kind: Operation`
 * document is never modified, so an incomplete explicit contract fails validation instead of
 * silently receiving defaults.
 *
 * Shorthand only removes repetition and constant ceremony. It never infers a business rule
 * or a permission: authority is still written (`establishes:`), just next to the read.
 *
 *   reads:                         -> facts + authority (one entry per read tool)
 *     orders.get:
 *       args: { id: request.orderId, tenant: principal.tenant }
 *       provides: [order.id, order.ownerId]
 *       establishes: [order.*]     # REQUIRED: the grant is explicit
 *   claims: [shipment.damaged]     -> caller claims (PROPOSING), as facts[request].claims
 *   (request facts)                -> request.<p> for every property of spec.input
 *   principal: { scopes: [...] }   -> required: true
 *   concurrency: { key }           -> mode: serialized_per_resource, maxQueue: 1000
 *   (failure omitted)              -> onUnverifiable/onModelError: refuse
 *   rules: - "a.b <= 30": too_old  -> { rule: "a.b <= 30", code: too_old }
 *          - "x == y": { code: c, unestablished: review }   -> unestablished: { outcome: review }
 *   effects: E: { args: { orderId: order.id, amountCents: { from: order.refundableCents, type: integer } } }
 *                                  -> mode/idempotency defaults; string arg = established, type string
 */
type Doc = Record<string, any>;

export const CONCISE_KIND = "ConciseOperation";
export const isConcise = (doc: unknown) => !!doc && typeof doc === "object" && (doc as Doc).kind === CONCISE_KIND;

const isShorthandRule = (r: unknown) => r !== null && typeof r === "object" && !Array.isArray(r) && !("rule" in (r as object)) && Object.keys(r as object).length === 1;
const show = (v: unknown) => JSON.stringify(v).replace(/"([A-Za-z_][\w]*)":/g, "$1: ").replace(/,/g, ", ");

function expandRule(r: unknown): unknown {
  if (!isShorthandRule(r)) return r;
  const [expr, v] = Object.entries(r as Record<string, unknown>)[0]!;
  if (typeof v === "string") return { rule: expr, code: v };
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { rule: expr };
  if (o.code) out.code = o.code;
  if (o.description) out.description = o.description;
  if (o.unestablished !== undefined) out.unestablished = typeof o.unestablished === "string" ? { outcome: o.unestablished } : o.unestablished;
  return out;
}

/** Concise-only constructs found in a `kind: Operation` document, as actionable messages. */
export function conciseConstructsInExplicit(doc: Doc): string[] {
  if (!doc || typeof doc !== "object" || isConcise(doc) || doc.kind !== "Operation") return [];
  const s = doc.spec ?? {};
  const out: string[] = [];
  const hint = `use kind: ${CONCISE_KIND} for concise syntax, or write the explicit form`;
  if (s.reads !== undefined) out.push(`spec.reads is concise syntax (${hint})`);
  if (s.claims !== undefined) out.push(`spec.claims is concise syntax (${hint})`);
  const rules: [string, unknown][] = [];
  for (const [n, c] of Object.entries((s.decision?.categories ?? {}) as Record<string, Doc>)) for (const [i, r] of ((c?.requires ?? []) as unknown[]).entries()) rules.push([`spec.decision.categories.${n}.requires[${i}]`, r]);
  for (const k of ["authorization", "preconditions", "invariants"]) for (const [i, r] of ((s.policy?.[k] ?? []) as unknown[]).entries()) rules.push([`spec.policy.${k}[${i}]`, r]);
  for (const [path, r] of rules) if (isShorthandRule(r)) out.push(`${path}: the "expr": code rule form is concise syntax (${hint})`);
  for (const [e, eff] of Object.entries((s.effects ?? {}) as Record<string, Doc>))
    for (const [a, v] of Object.entries((eff?.args ?? {}) as Record<string, unknown>))
      if (typeof v === "string" || (v && typeof v === "object" && "from" in (v as object) && !("authority" in (v as object)))) out.push(`spec.effects.${e}.args.${a}: the short argument form is concise syntax (${hint})`);
  return out;
}

/**
 * Expand a concise contract. Returns the document unchanged unless `kind: ConciseOperation`.
 * `notes`, if given, receives one line per default or expansion applied (path, kind, what).
 */
export function expandShorthand(input: Doc, notes?: string[]): Doc {
  if (!isConcise(input)) return input;
  const note = (path: string, what: string, detail: string) => notes?.push(`${path.padEnd(44)} ${what.padEnd(8)} ${detail}`);
  const doc: Doc = structuredClone(input);
  doc.kind = "Operation";
  const s = (doc.spec ??= {});
  if (s.reads !== undefined && (s.facts !== undefined || s.authority !== undefined)) throw new Error("use either spec.reads or spec.facts/spec.authority, not both");

  if (s.principal && s.principal.required === undefined) {
    s.principal = { required: true, ...s.principal };
    note("spec.principal.required", "default", "true");
  }
  if (s.concurrency) {
    if (s.concurrency.mode === undefined) note("spec.concurrency.mode", "default", "serialized_per_resource");
    if (s.concurrency.maxQueue === undefined) note("spec.concurrency.maxQueue", "default", "1000");
    s.concurrency = { mode: "serialized_per_resource", maxQueue: 1000, ...s.concurrency };
  }
  if (s.failure === undefined) {
    s.failure = { onUnverifiable: "refuse", onModelError: "refuse" };
    note("spec.failure", "default", show(s.failure));
  }

  if (s.reads !== undefined) {
    const reqProps = Object.keys(s.input?.properties ?? {});
    const request: Doc = { tool: "request", provides: reqProps.map((p) => `request.${p}`) };
    if (s.claims) request.claims = s.claims;
    const facts = [request];
    const authority: Doc[] = [{ id: "cap.request", channel: "principal", predicates: ["request.*"] }];
    note("spec.facts[0] / spec.authority[0]", "request", `request.{${reqProps.join(", ")}} from spec.input; grant cap.request on principal: [request.*]${s.claims ? `; claims ${show(s.claims)}` : ""}`);
    for (const [tool, r] of Object.entries(s.reads as Record<string, Doc>)) {
      if (!Array.isArray(r.establishes) || !r.establishes.length) throw new Error(`reads.${tool}: "establishes" is required (authority is never inferred)`);
      facts.push({ tool, ...(r.args ? { args: r.args } : {}), provides: r.provides });
      authority.push({ id: `cap.${tool}`, channel: `tool:${tool}`, predicates: r.establishes });
      note(`spec.facts[${facts.length - 1}] / spec.authority[${authority.length - 1}]`, "reads", `${tool} -> facts + grant cap.${tool} on tool:${tool}: ${show(r.establishes)}`);
    }
    s.facts = facts;
    s.authority = authority;
    delete s.reads;
    delete s.claims;
  }

  const expandList = (path: string, list: unknown) =>
    Array.isArray(list)
      ? list.map((r, i) => {
          const x = expandRule(r);
          if (x !== r) note(`${path}[${i}]`, "rule", `${show(Object.keys(r as object)[0])}: ${show(Object.values(r as object)[0])}`);
          return x;
        })
      : list;
  for (const [n, cat] of Object.entries((s.decision?.categories ?? {}) as Record<string, Doc>)) if (cat && cat.requires) cat.requires = expandList(`spec.decision.categories.${n}.requires`, cat.requires);
  if (s.policy) {
    for (const k of ["authorization", "preconditions", "invariants"]) if (s.policy[k]) s.policy[k] = expandList(`spec.policy.${k}`, s.policy[k]);
    for (const k of ["invariants", "authorization"])
      if (s.policy[k] === undefined) {
        s.policy[k] = [];
        note(`spec.policy.${k}`, "default", "[]");
      }
  }

  for (const [e, eff] of Object.entries((s.effects ?? {}) as Record<string, Doc>)) {
    if (eff.mode === undefined) (eff.mode = "effectful"), note(`spec.effects.${e}.mode`, "default", "effectful");
    if (eff.idempotency === undefined) (eff.idempotency = "required"), note(`spec.effects.${e}.idempotency`, "default", "required");
    for (const [name, a] of Object.entries((eff.args ?? {}) as Record<string, unknown>)) {
      if (typeof a === "string") {
        eff.args[name] = { type: "string", authority: "established", from: [a] };
        note(`spec.effects.${e}.args.${name}`, "arg", `${a} -> { type: string, authority: established, from: [${a}] }`);
      } else if (a && typeof a === "object" && "from" in (a as object) && !("authority" in (a as object))) {
        const o = a as { from: string | string[]; type?: string };
        eff.args[name] = { type: o.type ?? "string", authority: "established", from: Array.isArray(o.from) ? o.from : [o.from] };
        note(`spec.effects.${e}.args.${name}`, "arg", `{ from: ${o.from}${o.type ? `, type: ${o.type}` : ""} } -> { type: ${o.type ?? "string"}${o.type ? "" : " (default)"}, authority: established, from: [${o.from}] }`);
      }
    }
  }
  return doc;
}

/** Every default and expansion the compiler would apply to this document (empty for explicit contracts). */
export function explainShorthand(input: Doc): string[] {
  const notes: string[] = [];
  expandShorthand(input, notes);
  return notes;
}
