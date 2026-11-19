import { createHash } from "node:crypto";
import { canonicalJson as canonical } from "@modelnativ/contract-schema";
import type { AskInput, AskOutput, ModelAdapter, ModelInput, ModelOutput } from "./types.ts";

const approxTokens = (s: string) => Math.ceil(s.length / 4);

function out(id: string, input: ModelInput, value: unknown): ModelOutput {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text, modelId: id, promptTokens: approxTokens(JSON.stringify(input)), completionTokens: approxTokens(text) };
}

/** Returns whatever the script returns: an object (serialised) or a raw string (to test malformed output). */
export class ScriptedModel implements ModelAdapter {
  readonly id: string;
  calls = 0;
  asks = 0;
  constructor(
    private script: (input: ModelInput, call: number) => unknown,
    id = "mock:scripted",
    private answer?: (q: AskInput) => "yes" | "no",
  ) {
    this.id = id;
    if (!answer) (this as { ask?: unknown }).ask = undefined; // no ask(): confirmations cannot pass
  }
  async ask(q: AskInput): Promise<AskOutput> {
    this.asks++;
    return { answer: this.answer!(q), modelId: this.id, promptTokens: approxTokens(q.question + q.text), completionTokens: 1 };
  }
  async propose(input: ModelInput): Promise<ModelOutput> {
    const v = this.script(input, this.calls++);
    if (v instanceof Error) throw v;
    return out(this.id, input, v);
  }
}

/** Never answers. Used to prove timeouts fail closed. */
export class HangingModel implements ModelAdapter {
  readonly id = "mock:hanging";
  propose(): Promise<ModelOutput> {
    return new Promise(() => {});
  }
}

// ------------------------------------------------------------ record / replay

/** A recorded model call: its output, or (for replaying retries) the failure it produced. */
export type ModelRecord = {
  inputHash: string;
  modelId: string;
  output?: ModelOutput | AskOutput;
  kind?: "propose" | "ask";
  error?: string;
  code?: string;
  retryable?: boolean;
};

export class ReplayedModelError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: string, readonly modelId?: string) {
    super(message);
  }
}


export function hashModelInput(input: ModelInput | AskInput): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

/** Wraps any adapter and records each decision so it can be replayed without inference. */
export class RecordingModel implements ModelAdapter {
  readonly records: ModelRecord[] = [];
  constructor(private inner: ModelAdapter) {}
  get id() {
    return this.inner.id;
  }
  async propose(input: ModelInput, opts: { maxOutputTokens: number }): Promise<ModelOutput> {
    const output = await this.inner.propose(input, opts);
    this.records.push({ inputHash: hashModelInput(input), modelId: this.inner.id, output, kind: "propose" });
    return output;
  }
  get ask(): ModelAdapter["ask"] {
    if (!this.inner.ask) return undefined;
    return async (q, opts) => {
      const output = await this.inner.ask!(q, opts);
      this.records.push({ inputHash: hashModelInput(q), modelId: this.inner.id, output, kind: "ask" });
      return output;
    };
  }
}

export class ReplayMiss extends Error {}

/** Serves recorded decisions by input hash. A miss is an error, never a silent live call. */
export class ReplayModel implements ModelAdapter {
  private byHash = new Map<string, ModelRecord[]>();
  readonly id: string;
  constructor(records: ModelRecord[]) {
    for (const r of records) this.byHash.set(r.inputHash, [...(this.byHash.get(r.inputHash) ?? []), r]);
    this.id = `replay:${records[0]?.modelId ?? "empty"}`;
  }
  async propose(input: ModelInput): Promise<ModelOutput> {
    return this.take(hashModelInput(input)) as ModelOutput;
  }
  async ask(q: AskInput): Promise<AskOutput> {
    return this.take(hashModelInput(q)) as AskOutput;
  }
  private take(h: string) {
    const rec = this.byHash.get(h)?.shift();
    if (!rec) throw new ReplayMiss(`no recorded model decision for input ${h.slice(0, 12)}`);
    if (rec.error !== undefined) throw new ReplayedModelError(rec.error, rec.retryable === true, rec.code, rec.modelId);
    return rec.output!;
  }
}
