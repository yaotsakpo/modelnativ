/**
 * ModelNativ contract format, v1alpha1 (the typed IR of PRD §21.7, Phase 0 subset).
 *
 * A contract states, for one operation:
 *   - reads   (`facts`): which facts the kernel reads, through which tool;
 *   - authority (`authority`): which channel may ESTABLISH which facts. Resolved
 *     by the PSAP resolver. The model is never a channel with a grant;
 *   - the model's role (`model`): what it sees (data minimisation) and its budget;
 *   - the decision (`decision.categories`): the model picks a category; each
 *     category names the established facts it requires;
 *   - preconditions / invariants in a restricted expression language;
 *   - effects, with the provenance each argument needs, idempotency and mode;
 *   - consistency (`concurrency`) and tenancy.
 *
 * Unsupported IR features (postconditions, sagas, cross-resource transactions) are
 * absent from the schema, so a contract using them is REJECTED, never silently
 * downgraded to a prompt (§21.7).
 */

export const API_VERSION = "modelnativ.dev/v1alpha1";

/**
 * Stable machine-readable refusal codes. The first eight are PRD §21.9 (which
 * supersedes §8's names); the rest are §8 codes that §21.9 has no name for, plus
 * UNESTABLISHED_VALUE (PSAP provenance) and OVERLOADED (admission control).
 */
export const REFUSAL_CODES = [
  "UNAUTHENTICATED",
  "CAPABILITY_MISSING",
  "TENANT_VIOLATION",
  "SCHEMA_INVALID",
  "INVARIANT_VIOLATION",
  "STALE_STATE",
  "BUDGET_EXCEEDED",
  "UNSUPPORTED_EFFECT",
  "UNVERIFIABLE_PRECONDITION",
  "MODEL_TIMEOUT",
  "MODEL_ERROR",
  "CONTRACT_VERSION_MISMATCH",
  "REPLAY_DETECTED",
  /** A consequential effect argument was not established by a channel holding a
   *  grant for it, e.g. the model typed the value itself. */
  "UNESTABLISHED_VALUE",
  /** The model chose not to act. Conservative, never a gate failure. */
  "MODEL_DECLINED",
  /** A clarification token that is unknown, expired, already used, or not this caller's. One code: no oracle. */
  "CLARIFICATION_INVALID",
  "OVERLOADED",
  /** Infrastructure failure during commit (rolled back) or tool read. Nothing executed. */
  "EXECUTION_FAILED",
  /** A rate limit (tenant / principal / operation / API key) refused the call. Retry-After given. */
  "RATE_LIMITED",
  /** The request deadline passed before a decision; in-flight work was cancelled. */
  "DEADLINE_EXCEEDED",
  /** The model's circuit breaker is open: failing fast. Retry-After given. */
  "MODEL_UNAVAILABLE",
  /** Another attempt with the same idempotency key and payload is still running. Retry-After given. */
  "IDEMPOTENCY_IN_PROGRESS",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const REVIEW_CODES = [
  "UNESTABLISHED_REQUIREMENT",
  "CATEGORY_REQUIRES_REVIEW",
  "MODEL_REQUESTED_REVIEW",
  /** Intent policy: the model reported ambiguous/no intent, or less than the category's minimum. */
  "INTENT_NOT_ESTABLISHED",
  /** Intent policy: the quoted evidence is not in the evidence source. */
  "INTENT_UNGROUNDED",
  /** Intent policy: the category's confirmation question was not answered yes. */
  "INTENT_UNCONFIRMED",
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

export type GateOutcome = "ALLOW" | "REFUSE" | "REVIEW";

/** Review codes a contract may turn into a question to the caller (intent only, never facts or policy). */
export const CLARIFIABLE_CODES = ["INTENT_NOT_ESTABLISHED", "INTENT_UNCONFIRMED", "INTENT_UNGROUNDED", "MODEL_REQUESTED_REVIEW"] as const;
export type ClarifiableCode = (typeof CLARIFIABLE_CODES)[number];

/**
 * Optional interactive clarification. When the intent policy cannot establish intent (one of
 * `on`), the runtime asks the caller `question`, persists the pending operation, and on resume
 * re-runs the WHOLE pipeline with the caller's answer added as the request fact `field`.
 * The answer is the caller's own words on the caller's own channel: it can never establish
 * anything the caller could not have stated in the first request.
 */
export type ClarifySpec = {
  on: ClarifiableCode[];
  field: string;
  question: string;
  /** "categories": one choice per non-abstain category (its clarifyAs text), plus "something else". */
  choices: "categories";
  allowText: boolean;
  ttlSeconds: number;
  maxRounds: number;
};

// ------------------------------------------------------------ contract

export type FactSource = {
  /** "request" is built in: the authenticated request body. */
  tool: string;
  /** Tool argument -> fact predicate it is read from (e.g. orderId: request.orderId). */
  args?: Record<string, string>;
  /** Predicates this tool's result supplies; the tool returns an object keyed by these. */
  provides: string[];
  /** Predicates this source asserts WITHOUT a grant (e.g. a customer's claim about a
   *  shipment). Minted on this source's channel; PSAP derives PROPOSING. */
  claims?: string[];
};

export type AuthorityGrant = {
  id: string;
  /** "principal" (the authenticated caller) or "tool:<name>". */
  channel: string;
  /** Exact predicates or trailing-wildcard prefixes ("order.*"). */
  predicates: string[];
};

/**
 * A rule: a restricted expression, optionally with
 *   description   shown to humans (docs, refusal details)
 *   code          the application-level reason returned when the rule fails (e.g. "too_old"),
 *                 so migrated operations keep the original's error codes
 *   unestablished what to do when a fact it needs is not established (overrides the category default)
 */
export type Rule = string | { rule: string; description?: string; code?: string; unestablished?: { outcome: "review" | "refuse"; code?: string } };

/** An executable, documented example. The compiler validates `request` against the input schema. */
export type ContractExample = {
  name: string;
  description?: string;
  principal: { subject: string; tenant?: string };
  request: Record<string, unknown>;
  expect: { outcome: GateOutcome; code?: string };
};

export const INTENT_LEVELS = ["explicit", "implied", "ambiguous", "none"] as const;
export type IntentLevel = (typeof INTENT_LEVELS)[number];

/** Per-category intent requirements. Can only route a proposal to REVIEW, never authorize one. */
export type CategoryIntent = {
  /** Weakest intent level that may select this category (default "implied"). */
  minimum?: "explicit" | "implied";
  /**
   * Yes/no questions asked of the model, separately, about the evidence source only. A string
   * expects "yes". A list states the expected answer for each question; asking in both
   * polarities counters a model's yes-bias. Every answer must match, or the proposal goes to REVIEW.
   */
  confirm?: string | { ask: string; expect: "yes" | "no" }[];
};

export type DecisionCategory = {
  description: string;
  /** Caller-facing wording used as a clarification choice (defaults to the description). */
  clarifyAs?: string;
  intent?: CategoryIntent;
  /** Expressions over established facts; all must hold for this category to authorize effects. */
  requires?: Rule[];
  /** When a required fact is not established: review (default) or refuse. */
  onUnestablished?: "review" | "refuse";
  /** The category never authorizes an effect on its own. */
  alwaysReview?: boolean;
  /** Application reason returned when this category routes to review (e.g. the original's "other"). */
  code?: string;
  /** The effect this category performs (required when the contract declares several effects). */
  effect?: string;
};

export type RetrySpec = { maxAttempts: number; baseMs: number; maxMs: number; jitter: "full" | "equal" | "none" };

/** Per-operation reliability policy. Transport-level only: policy refusals are never retried. */
export type ReliabilitySpec = {
  /** End-to-end request deadline; cancels tool reads and inference in flight. */
  deadlineMs?: number;
  /** Retries of the model CALL on transport failures (adapter error flagged retryable, per-attempt timeout). */
  model?: { retry?: RetrySpec; breaker?: { failures: number; windowMs: number; openMs: number } };
  /** Timeouts and retries of read tools (only failures flagged retryable). */
  tools?: { timeoutMs?: number; retry?: RetrySpec };
};

/**
 * Where the decision category comes from.
 *   model   (default) a model interprets unstructured input (the Phase 0 behaviour)
 *   field   the category is the caller's structured request field; no model is called
 *   hybrid  the structured field when supplied and valid, otherwise the model
 * A structured category states what the caller REQUESTS; it establishes no external fact.
 */
export type DecisionSource = {
  /**
   * "fixed": a single-path deterministic operation; always `category`, never a model.
   * "fact":  the category is the mapped value of an ESTABLISHED fact (e.g. a state computed by a
   *          read tool), not of the request. Deterministic; never a model.
   */
  mode: "model" | "field" | "hybrid" | "fixed" | "fact";
  category?: string;
  /** A request fact (the caller's own channel) holding the structured value. */
  field?: string;
  /** External value -> category name. Defaults to identity over the category names. */
  values?: Record<string, string>;
};

export type EffectArgSpec = {
  type: "string" | "integer";
  /**
   * established: the model must reference a fact (`{ref}`) that resolves to an
   *   ESTABLISHING value from one of `from`. A literal typed by the model is
   *   PROPOSING and cannot satisfy it.
   * bounded: the model may propose a literal; the invariants bound it.
   */
  authority: "established" | "bounded";
  from?: string[];
  /** For bounded args: the fact used when the model proposes no value (e.g. the full balance). */
  default?: string;
  /** For bounded args on the structured path: a request fact the caller may supply (still bounded by invariants). */
  fromRequest?: string;
};

export type EffectSpec = {
  mode: "effectful";
  idempotency: "required";
  args: Record<string, EffectArgSpec>;
};

export type Contract = {
  apiVersion: typeof API_VERSION;
  kind: "Operation";
  metadata: { name: string; version: number; summary?: string; description?: string };
  spec: {
    input: Record<string, unknown>;
    principal: { required: true; scopes: string[] };
    /** The fact naming the tenant of the resource; must equal principal.tenant. */
    /** `code`: the application reason when the tenant-scoped record is not found (e.g. "not_found"). */
    tenancy: { key: string; code?: string };
    /** versionFact is optional: without it, effect adapters must guard writes with conditional updates. */
    concurrency: { mode: "serialized_per_resource"; key: string; versionFact?: string; maxQueue: number };
    facts: FactSource[];
    authority: AuthorityGrant[];
    /** Required unless decision.source.mode is "field". */
    model?: {
      role: string;
      /** Only these facts are placed in the model's context (minimisation, §21.1.3). */
      sees: string[];
      budget: { timeoutMs: number; maxOutputTokens: number; maxRetries: number };
    };
    decision: {
      categories: Record<string, DecisionCategory>;
      /** The category that means "intent not establishable"; must be alwaysReview. */
      abstain?: string;
      /** Enables the intent policy: the model must report an intent level and quote evidence from these facts. */
      evidence?: { from: string | string[] };
      source?: DecisionSource;
      /** "sequential": a category's requires are checked in order; the first non-true rule decides. Default "all". */
      evaluation?: "all" | "sequential";
    };
    policy: {
      /** Resource-level authorization. A false result refuses with CAPABILITY_MISSING. */
      authorization: Rule[];
      /** Business invariants. A false result refuses with INVARIANT_VIOLATION. */
      invariants: Rule[];
      /**
       * Fact-only checks evaluated IN ORDER after authorization and before the decision step.
       * First non-true decides. Used to preserve a legacy function's error precedence
       * (e.g. a limit checked before any per-category rule) without changing the global gate.
       */
      preconditions?: Rule[];
    };
    /** Documentation and executable examples. Never read by enforcement. */
    examples?: ContractExample[];
    reliability?: ReliabilitySpec;
    clarify?: ClarifySpec;
    /**
     * What an idempotency key remembers when an attempt ends WITHOUT a committed effect.
     *   settle "terminal": business refusals and REVIEW are the key's answer for retentionMs
     *   settle "release" : nothing is remembered; a retry with the same key re-evaluates
     * Absent: the runtime's configured default ("release" unless configured otherwise).
     * Recommended for new operations: { settle: terminal }.
     */
    idempotency?: { settle?: "release" | "terminal"; retentionMs?: number };
    effects: Record<string, EffectSpec>;
    failure: { onUnverifiable: "refuse"; onModelError: "refuse" };
  };
};

const IDENT = "^[a-z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_*]+)*$";
const RETRY = {
  type: "object",
  additionalProperties: false,
  required: ["maxAttempts", "baseMs", "maxMs", "jitter"],
  properties: {
    maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
    baseMs: { type: "integer", minimum: 0 },
    maxMs: { type: "integer", minimum: 0 },
    jitter: { enum: ["full", "equal", "none"] },
  },
} as const;
const RULE = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["rule"],
      properties: {
        rule: { type: "string" },
        description: { type: "string" },
        code: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
        unestablished: {
          type: "object",
          additionalProperties: false,
          required: ["outcome"],
          properties: { outcome: { enum: ["review", "refuse"] }, code: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" } },
        },
      },
    },
  ],
} as const;
const PRED = { type: "string", pattern: IDENT } as const;
const strict = (required: string[], properties: Record<string, unknown>) =>
  ({ type: "object", additionalProperties: false, required, properties }) as const;

/** Structural schema for a contract document. Semantics are checked by the compiler. */
export const CONTRACT_JSON_SCHEMA = strict(["apiVersion", "kind", "metadata", "spec"], {
  apiVersion: { const: API_VERSION },
  kind: { const: "Operation" },
  metadata: strict(["name", "version"], {
    name: PRED,
    version: { type: "integer", minimum: 1 },
    summary: { type: "string" },
    description: { type: "string" },
  }),
  spec: strict(
    ["input", "principal", "tenancy", "concurrency", "facts", "authority", "decision", "policy", "effects", "failure"],
    {
      input: { type: "object" },
      principal: strict(["required", "scopes"], {
        required: { const: true },
        scopes: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      }),
      tenancy: strict(["key"], { key: PRED, code: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" } }),
      concurrency: strict(["mode", "key", "maxQueue"], {
        mode: { const: "serialized_per_resource" },
        key: PRED,
        versionFact: PRED,
        maxQueue: { type: "integer", minimum: 1, maximum: 100000 },
      }),
      facts: {
        type: "array",
        minItems: 1,
        items: strict(["tool", "provides"], {
          tool: PRED,
          args: { type: "object", additionalProperties: PRED },
          provides: { type: "array", minItems: 1, items: PRED },
          claims: { type: "array", items: PRED },
        }),
      },
      authority: {
        type: "array",
        minItems: 1,
        items: strict(["id", "channel", "predicates"], {
          id: { type: "string", minLength: 1 },
          channel: { type: "string", pattern: "^(principal|tool:[a-z][a-zA-Z0-9_.]*)$" },
          predicates: { type: "array", minItems: 1, items: PRED },
        }),
      },
      model: strict(["role", "sees", "budget"], {
        role: { type: "string", minLength: 1 },
        sees: { type: "array", items: PRED },
        budget: strict(["timeoutMs", "maxOutputTokens", "maxRetries"], {
          timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
          maxOutputTokens: { type: "integer", minimum: 16, maximum: 4096 },
          maxRetries: { type: "integer", minimum: 0, maximum: 3 },
        }),
      }),
      decision: strict(["categories"], {
        abstain: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
        evaluation: { enum: ["all", "sequential"] },
        source: strict(["mode"], {
          mode: { enum: ["model", "field", "hybrid", "fixed", "fact"] },
          category: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
          field: PRED,
          values: { type: "object", minProperties: 1, propertyNames: { pattern: "^[A-Za-z0-9_-]{1,64}$" }, additionalProperties: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" } },
        }),
        evidence: strict(["from"], { from: { oneOf: [PRED, { type: "array", minItems: 1, maxItems: 4, items: PRED }] } }),
        categories: {
          type: "object",
          minProperties: 1,
          propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
          additionalProperties: strict(["description"], {
            description: { type: "string" },
            requires: { type: "array", items: RULE },
            onUnestablished: { enum: ["review", "refuse"] },
            alwaysReview: { type: "boolean" },
            clarifyAs: { type: "string", minLength: 3, maxLength: 200 },
            code: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
            effect: { type: "string" },
            intent: strict([], {
              minimum: { enum: ["explicit", "implied"] },
              confirm: {
                oneOf: [
                  { type: "string", minLength: 5, maxLength: 300 },
                  {
                    type: "array",
                    minItems: 1,
                    maxItems: 3,
                    items: strict(["ask", "expect"], { ask: { type: "string", minLength: 5, maxLength: 300 }, expect: { enum: ["yes", "no"] } }),
                  },
                ],
              },
            }),
          }),
        },
      }),
      policy: strict(["authorization", "invariants"], {
        authorization: { type: "array", items: RULE },
        invariants: { type: "array", items: RULE },
        preconditions: { type: "array", items: RULE },
      }),
      clarify: strict(["on", "field", "question", "choices", "allowText", "ttlSeconds", "maxRounds"], {
        on: { type: "array", minItems: 1, items: { enum: ["INTENT_NOT_ESTABLISHED", "INTENT_UNCONFIRMED", "INTENT_UNGROUNDED", "MODEL_REQUESTED_REVIEW"] } },
        field: PRED,
        question: { type: "string", minLength: 5, maxLength: 300 },
        choices: { const: "categories" },
        allowText: { type: "boolean" },
        ttlSeconds: { type: "integer", minimum: 60, maximum: 2592000 },
        maxRounds: { type: "integer", minimum: 1, maximum: 3 },
      }),
      idempotency: strict([], {
        settle: { enum: ["release", "terminal"] },
        retentionMs: { type: "integer", minimum: 60000, maximum: 31536000000 },
      }),
      reliability: strict([], {
        deadlineMs: { type: "integer", minimum: 1, maximum: 600000 },
        model: strict([], {
          retry: RETRY,
          breaker: strict(["failures", "windowMs", "openMs"], {
            failures: { type: "integer", minimum: 1, maximum: 1000 },
            windowMs: { type: "integer", minimum: 1 },
            openMs: { type: "integer", minimum: 1 },
          }),
        }),
        tools: strict([], { timeoutMs: { type: "integer", minimum: 1, maximum: 600000 }, retry: RETRY }),
      }),
      examples: {
        type: "array",
        items: strict(["name", "principal", "request", "expect"], {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          principal: strict(["subject"], { subject: { type: "string" }, tenant: { type: "string" } }),
          request: { type: "object" },
          expect: strict(["outcome"], { outcome: { enum: ["ALLOW", "REFUSE", "REVIEW"] }, code: { type: "string" } }),
        }),
      },
      effects: {
        type: "object",
        minProperties: 1,
        additionalProperties: strict(["mode", "idempotency", "args"], {
          mode: { const: "effectful" },
          idempotency: { const: "required" },
          args: {
            type: "object",
            minProperties: 1,
            additionalProperties: strict(["type", "authority"], {
              type: { enum: ["string", "integer"] },
              authority: { enum: ["established", "bounded"] },
              from: { type: "array", minItems: 1, items: PRED },
              default: PRED,
              fromRequest: PRED,
            }),
          },
        }),
      },
      failure: strict(["onUnverifiable", "onModelError"], {
        onUnverifiable: { const: "refuse" },
        onModelError: { const: "refuse" },
      }),
    },
  ),
});

// ------------------------------------------------------------ proposal

/** An effect argument is either a reference to a fact or a literal value. */
export type ArgValue = { ref: string } | { value: string | number };

/** What the model returns. Data only; it carries no authority. */
export type Proposal = {
  operation: string;
  contractVersion: number;
  decision: "PROPOSE_EFFECT" | "REFUSE" | "REVIEW";
  category: string;
  effects: { tool: string; args: Record<string, ArgValue> }[];
  /** Present when the contract has an intent policy. `confirmed` is set by the RUNTIME only. */
  intent?: { level: IntentLevel; evidence: string; confirmed?: boolean };
};

/** The authenticated caller. Built by ingress from a verified credential only. */
export type Principal = {
  subject: string;
  tenant: string;
  sessionId: string;
  scopes: string[];
  /** Expiry of the credential this context was derived from. */
  expiresAt: number;
  /** API key id, when the caller authenticated with one (for per-key rate limits). */
  keyId?: string;
};

// ------------------------------------------------------------ shared utilities

/** Canonical JSON (sorted keys, no whitespace). The ONE implementation used for every hash. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
