/** What the model is given. Built by the runtime from the contract; never contains secrets or authority. */
export type ModelInput = {
  operation: string;
  contractVersion: number;
  role: string;
  categories: { name: string; description: string }[];
  /** Untrusted observations, limited to the contract's `model.sees` list. */
  observations: Record<string, unknown>;
  effects: { tool: string; args: { name: string; type: string; authority: string; from?: string[]; default?: string }[] }[];
  /** Facts the model may reference with {"ref": ...}. Names only, no values. */
  referenceable: string[];
  proposalSchema: Record<string, unknown>;
  /** Present when the contract declares an intent policy. */
  intent?: { evidenceFrom: string };
};

/** A yes/no question about a piece of text (the intent policy's confirmation step). */
export type AskInput = { question: string; text: string };
export type AskOutput = { answer: "yes" | "no"; modelId: string; promptTokens: number; completionTokens: number };

export type ModelOutput = {
  text: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
};

export interface ModelAdapter {
  /** Pinned identity: name plus artifact digest where there is one. */
  readonly id: string;
  /** `signal` aborts in-flight inference (deadline or per-attempt timeout). */
  propose(input: ModelInput, opts: { maxOutputTokens: number; signal?: AbortSignal }): Promise<ModelOutput>;
  /** Optional. An adapter without it cannot confirm, so confirmation-gated categories go to review. */
  ask?(q: AskInput, opts: { maxOutputTokens: number; signal?: AbortSignal }): Promise<AskOutput>;
}
