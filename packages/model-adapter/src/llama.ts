/**
 * Local model adapter over llama.cpp (node-llama-cpp).
 *
 * - The artifact is pinned: its sha256 must match the manifest before it loads.
 * - Decoding follows a DecodingPlan (full | compact | category | free); whatever
 *   the model emits is mapped onto the full proposal, which the gate validates.
 * - Greedy (temperature 0). One context sequence, calls serialised.
 * - reusePrefix: keep the evaluated system prompt in the KV cache between calls,
 *   so only the per-request part is prefilled. Each call still starts a fresh chat.
 * - The model gets no tools, no network and no database: text in, text out.
 * - Per-call timings (prefill ≈ time to first chunk, generation) are exposed on
 *   `lastTimings` for profiling.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { decodingPlan, type DecodingMode } from "./decoding.ts";
import { buildAskPrompt, buildPrompt } from "./prompt.ts";
import type { AskInput, AskOutput, ModelAdapter, ModelInput, ModelOutput } from "./types.ts";

export type ModelArtifact = {
  id: string;
  path: string;
  sha256: string;
  license: string;
  quantization: string;
  contextSize: number;
};

export type LlamaOptions = { verify?: boolean; gpu?: boolean; decoding?: DecodingMode; reusePrefix?: boolean };

export type CallTimings = {
  /** Before generation: plan, grammar lookup, prompt build, KV clear, chat session creation. */
  setupMs: number;
  firstChunkMs: number;
  totalMs: number;
  /** After generation: mapping to the full proposal and token counting. */
  finishMs: number;
  outputTokens: number;
  mode: DecodingMode;
  rawText: string;
};

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export class LlamaModel implements ModelAdapter {
  readonly id: string;
  lastTimings: CallTimings | null = null;
  private ready: Promise<{ LlamaChatSession: any; sequence: any; askSequence: any; llama: any; model: any }> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private grammars = new Map<string, any>();
  private lastSystem: string | null = null;
  private lastAskSystem: string | null = null;
  private sessions = new Map<string, any>();

  constructor(private artifact: ModelArtifact, private opts: LlamaOptions = {}) {
    const d = opts.decoding ?? "full";
    this.id = `${artifact.id}@sha256:${artifact.sha256.slice(0, 12)}${d === "full" ? "" : `#${d}`}${opts.reusePrefix ? "+prefix" : ""}`;
  }

  private init() {
    this.ready ??= (async () => {
      if (this.opts.verify !== false) {
        const got = await sha256File(this.artifact.path);
        if (got !== this.artifact.sha256) throw new Error(`model artifact digest mismatch: ${got} != ${this.artifact.sha256}`);
      }
      // Not installed by default: only local-model (free-text) decisions need it. The specifier is a
      // variable so the project typechecks whether or not the package is installed.
      const pkg = "node-llama-cpp";
      const { getLlama, LlamaChatSession } = await (import(pkg) as Promise<any>).catch((e: unknown) => {
        throw new Error(`local models need the optional dependency node-llama-cpp (install it with \`pnpm add node-llama-cpp\`): ${(e as Error).message}`);
      });
      const llama = await getLlama(this.opts.gpu === false ? { gpu: false } : undefined);
      const model = await llama.loadModel({ modelPath: this.artifact.path, ...(this.opts.gpu === false ? { gpuLayers: 0 } : {}) });
      // Two sequences: proposals and confirmations keep their own cached prompt prefixes
      // instead of evicting each other on every alternation.
      const context = await model.createContext({ contextSize: this.artifact.contextSize, sequences: 2 });
      return { LlamaChatSession, sequence: context.getSequence(), askSequence: context.getSequence(), llama, model };
    })();
    return this.ready;
  }

  async warm(): Promise<void> {
    await this.init();
  }

  /** Same loaded weights and grammar cache, different decoding options (for benchmarking variants). */
  derive(opts: Partial<LlamaOptions>): LlamaModel {
    const m = new LlamaModel(this.artifact, { ...this.opts, ...opts, verify: false });
    m.ready = this.init();
    m.grammars = this.grammars;
    m.chain = this.chain;
    m.shareChain = this;
    return m;
  }
  private shareChain: LlamaModel | null = null;

  /** Yes/no confirmation under a two-value grammar. Serialised with propose() on the same sequence. */
  ask(q: AskInput, opts: { maxOutputTokens: number; signal?: AbortSignal }): Promise<AskOutput> {
    const run = async (): Promise<AskOutput> => {
      const { LlamaChatSession, askSequence: sequence, llama, model } = await this.init();
      const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { enum: ["yes", "no"] } } };
      const key = JSON.stringify(schema);
      let grammar = this.grammars.get(key);
      if (!grammar) {
        grammar = await llama.createGrammarForJsonSchema(schema);
        this.grammars.set(key, grammar);
      }
      const { system, user } = buildAskPrompt(q);
      if (!this.opts.reusePrefix || this.lastAskSystem !== system) await sequence.clearHistory();
      const root = this.shareChain ?? this;
      let chat = root.sessions.get(`ask\u0000${system}`);
      if (!chat) {
        chat = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system, autoDisposeSequence: false });
        root.sessions.set(`ask\u0000${system}`, chat);
      } else chat.resetChatHistory();
      this.lastAskSystem = system;
      const raw: string = await chat.prompt(user, { grammar, maxTokens: Math.max(opts.maxOutputTokens, 8), temperature: 0, signal: opts.signal, stopOnAbortSignal: false });
      let answer: "yes" | "no" = "no";
      try {
        answer = JSON.parse(raw).answer === "yes" ? "yes" : "no";
      } catch {
        /* anything unparseable is "no": confirmation fails closed */
      }
      return { answer, modelId: this.id, promptTokens: model.tokenize(system).length + model.tokenize(user).length, completionTokens: model.tokenize(raw).length };
    };
    const root = this.shareChain ?? this;
    const p = root.chain.then(run, run);
    root.chain = p.catch(() => {});
    return p;
  }

  propose(input: ModelInput, opts: { maxOutputTokens: number; signal?: AbortSignal }): Promise<ModelOutput> {
    const run = async (): Promise<ModelOutput> => {
      const { LlamaChatSession, sequence, llama, model } = await this.init();
      const tSetup = performance.now();
      const plan = decodingPlan(input, this.opts.decoding ?? "full");
      let grammar: any;
      if (plan.schema) {
        const key = JSON.stringify(plan.schema);
        grammar = this.grammars.get(key);
        if (!grammar) {
          grammar = await llama.createGrammarForJsonSchema(plan.schema);
          this.grammars.set(key, grammar);
        }
      }
      const { system, user } = buildPrompt(input, plan.mode === "full" && !this.opts.decoding ? undefined : plan.format);
      // Without prefix reuse, start from an empty KV cache every call (Phase 0 behaviour).
      // With it, node-llama-cpp re-evaluates only tokens after the longest matching prefix.
      if (!this.opts.reusePrefix || this.lastSystem !== system) await sequence.clearHistory();
      // One chat session per system prompt, history reset each call: constructing a session costs 20-40 ms.
      const root = this.shareChain ?? this;
      let chat = root.sessions.get(system);
      if (!chat) {
        chat = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system, autoDisposeSequence: false });
        root.sessions.set(system, chat);
      } else chat.resetChatHistory();
      this.lastSystem = system;
      const t0 = performance.now();
      const setupMs = t0 - tSetup;
      let first = -1;
      try {
        const raw: string = await chat.prompt(user, {
          grammar,
          maxTokens: opts.maxOutputTokens,
          temperature: 0,
          signal: opts.signal,
          stopOnAbortSignal: false,
          onTextChunk: () => {
            if (first < 0) first = performance.now() - t0;
          },
        });
        const totalMs = performance.now() - t0;
        let text = raw;
        try {
          text = plan.toProposal(raw);
        } catch {
          /* leave raw: the engine's parse fails and it retries within budget */
        }
        const outTok = model.tokenize(raw).length;
        const promptTokens = model.tokenize(system).length + model.tokenize(user).length;
        this.lastTimings = { setupMs, firstChunkMs: first, totalMs, finishMs: performance.now() - t0 - totalMs, outputTokens: outTok, mode: plan.mode, rawText: raw };
        return { text, modelId: this.id, promptTokens, completionTokens: outTok };
      } finally {
        /* the session is kept for the next call with the same system prompt */
      }
    };
    const root = this.shareChain ?? this;
    const p = root.chain.then(run, run);
    root.chain = p.catch(() => {});
    return p;
  }
}
