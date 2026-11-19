/**
 * A deterministic keyword stand-in for a small model, specific to the refund example.
 * (Moved out of the framework: it hard-codes refund vocabulary and fact names.)
 */
import type { ModelAdapter, ModelInput, ModelOutput } from "@modelnativ/model-adapter";

export class KeywordModel implements ModelAdapter {
  readonly id = "mock:keyword@1";
  async propose(input: ModelInput): Promise<ModelOutput> {
    const msg = String(input.observations["request.message"] ?? "").toLowerCase();
    const cats = new Set(input.categories.map((c) => c.name));
    const pick = (name: string) => (cats.has(name) ? name : "OTHER");
    let category = "OTHER";
    if (/(broken|damaged|crushed|cracked|shattered|smashed|defect)/.test(msg)) category = pick("DAMAGED");
    else if (/(never arrived|not arrived|didn'?t arrive|never received|not received|lost)/.test(msg)) category = pick("NOT_DELIVERED");
    else if (/(changed my mind|don'?t want|do not want|no longer|return it|don'?t need)/.test(msg)) category = pick("CHANGED_MIND");
    const effect = input.effects[0];
    const proposal =
      category === "OTHER" || !effect
        ? { operation: input.operation, contractVersion: input.contractVersion, decision: "REVIEW", category, effects: [] }
        : {
            operation: input.operation,
            contractVersion: input.contractVersion,
            decision: "PROPOSE_EFFECT",
            category,
            effects: [{ tool: effect.tool, args: Object.fromEntries(effect.args.map((a) => [a.name, a.authority === "established" ? { ref: a.from![0] } : { ref: a.default ?? "order.refundableCents" }])) }],
          };
    const text = JSON.stringify(proposal);
    return { text, modelId: this.id, promptTokens: Math.ceil(JSON.stringify(input).length / 4), completionTokens: Math.ceil(text.length / 4) };
  }
}
