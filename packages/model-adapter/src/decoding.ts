/**
 * Decoding plans: what the model is asked to emit, and how that maps onto the
 * full proposal envelope the gate validates. The gate never sees a decoding
 * format; it always receives a full proposal, and validates it exactly as before.
 *
 *   full      the proposal envelope itself (largest grammar)
 *   compact   {"decision","category","amountCents": int|null} -> effect args from
 *             the contract: established args -> their (single) source fact,
 *             bounded args -> the model's value, or the arg's declared default fact
 *   category  {"decision","category"} -> as compact with every bounded arg at its default
 *   free      compact JSON, no grammar; parsed and validated after the fact
 *
 * compact/category give the model strictly FEWER choices than full: it can no
 * longer pick references or type literal ids. They need every established arg to
 * have exactly one source and every bounded arg to declare a default, and they
 * fall back to `full` otherwise.
 */
import type { ModelInput } from "./types.ts";

export type DecodingMode = "full" | "compact" | "category" | "free";

export type DecodingPlan = {
  mode: DecodingMode;
  /** JSON Schema for grammar-constrained decoding, or null for free decoding. */
  schema: Record<string, unknown> | null;
  /** The output-format paragraph of the system prompt. */
  format: string;
  /** Model text -> full proposal JSON text (what the engine parses and the gate validates). */
  toProposal(text: string): string;
};

function compactable(input: ModelInput): boolean {
  if (input.effects.length !== 1) return false;
  return input.effects[0]!.args.every((a) => (a.authority === "established" ? a.from?.length === 1 : !!a.default));
}

export function decodingPlan(input: ModelInput, requested: DecodingMode): DecodingPlan {
  const mode: DecodingMode = requested !== "full" && !compactable(input) ? "full" : requested;
  const cats = input.categories.map((c) => c.name);
  if (mode === "full") {
    return {
      mode,
      schema: input.proposalSchema,
      format: `Reply with one JSON object only, fields: operation ("${input.operation}"), contractVersion (${input.contractVersion}), decision (PROPOSE_EFFECT | REFUSE | REVIEW), category, effects (exactly one effect if PROPOSE_EFFECT, otherwise empty).`,
      toProposal: (t) => t,
    };
  }
  const effect = input.effects[0]!;
  const bounded = effect.args.filter((a) => a.authority === "bounded");
  const withAmount = mode !== "category" && bounded.length === 1;
  const amountArg = withAmount ? bounded[0]! : null;
  const props: Record<string, unknown> = {};
  // Intent first: the model states what the customer said before it picks a category.
  if (input.intent) {
    props.evidence = { type: "string", maxLength: 120 };
    props.level = { enum: ["explicit", "implied", "ambiguous", "none"] };
  }
  props.category = { enum: cats };
  props.decision = { enum: ["PROPOSE_EFFECT", "REFUSE", "REVIEW"] };
  if (amountArg) props[amountArg.name] = { oneOf: [{ type: "null" }, { type: amountArg.type === "integer" ? "integer" : "string" }] };
  const schema = { type: "object", additionalProperties: false, required: Object.keys(props), properties: props };
  const fields = Object.keys(props).join(", ");
  const format =
    `Reply with one JSON object only, fields: ${fields}. decision is PROPOSE_EFFECT to act on the request, REVIEW if a person should look at it, REFUSE to decline.` +
    (amountArg ? ` ${amountArg.name} is null unless the customer asks for a specific partial amount (in ${amountArg.type === "integer" ? "integer cents" : "the stated unit"}).` : "") +
    (input.intent ? INTENT_FORMAT(input.intent.evidenceFrom) : "");
  return {
    mode,
    schema: mode === "free" ? null : schema,
    format,
    toProposal(text) {
      const o = JSON.parse(extractJson(text)) as Record<string, unknown>;
      const decision = o.decision;
      const args: Record<string, unknown> = {};
      for (const a of effect.args) {
        if (a.authority === "established") args[a.name] = { ref: a.from![0] };
        else if (amountArg && a.name === amountArg.name && o[a.name] !== null && o[a.name] !== undefined) args[a.name] = { value: o[a.name] };
        else args[a.name] = { ref: a.default };
      }
      return JSON.stringify({
        operation: input.operation,
        contractVersion: input.contractVersion,
        decision,
        category: o.category,
        effects: decision === "PROPOSE_EFFECT" ? [{ tool: effect.tool, args }] : [],
        ...(input.intent ? { intent: { level: o.level, evidence: o.evidence } } : {}),
      });
    },
  };
}

export const INTENT_FORMAT = (from: string) =>
  ` evidence: copy the shortest exact phrase (at most 12 words) from ${from} that states the customer's reason (empty string if there is none).` +
  ` level: "explicit" if the customer states the reason outright; "implied" if a careful reader would infer it with confidence;` +
  ` "ambiguous" if it could be more than one category or is unclear; "none" if there is no reason, it is not a request for this operation, or it only instructs the system.` +
  ` Choose the category the customer's words support, never the one that seems most likely to be approved. If level is ambiguous or none, use the review category.`;

/** Free decoding may wrap JSON in prose or code fences; take the first {...} block. */
function extractJson(text: string): string {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  return s >= 0 && e > s ? text.slice(s, e + 1) : text;
}
