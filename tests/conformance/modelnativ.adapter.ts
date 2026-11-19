/**
 * Modelnativ under the conformance suite. The model is scripted to classify each
 * request as the reason the customer chose, so this measures the kernel's
 * guarantees, not classification quality (that is bench/).
 */
import { buildRefundApp } from "@modelnativ/example-refund-migrated";
import { MemorySecretStore } from "@modelnativ/effect-executor";
import { ScriptedModel } from "@modelnativ/model-adapter";
import { MemoryAudit } from "@modelnativ/observability";
import { FaultPlan, SeededRandom, VirtualClock, freeScheduler } from "@modelnativ/runtime";
import type { Instance, Kind, RefundImpl } from "./types.ts";

const KIND: Record<string, Kind> = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  CAPABILITY_MISSING: "FORBIDDEN",
  TENANT_VIOLATION: "NOT_FOUND",
  SCHEMA_INVALID: "INVALID",
  INVARIANT_VIOLATION: "POLICY",
  UNESTABLISHED_VALUE: "POLICY",
  STALE_STATE: "CONFLICT",
  REPLAY_DETECTED: "CONFLICT",
  EXECUTION_FAILED: "UNAVAILABLE",
  MODEL_TIMEOUT: "UNAVAILABLE",
  MODEL_ERROR: "UNAVAILABLE",
  OVERLOADED: "UNAVAILABLE",
};

/**
 * structured=false: free-text path; a scripted model echoes the chosen reason (kernel guarantees only).
 * structured=true:  the reason is sent as the contract's structured field; the model THROWS if called.
 */
function makeImpl(name: string, structured: boolean): RefundImpl {
  return {
  name,
  create({ clockStart }): Instance {
    const clock = new VirtualClock(clockStart);
    const faults = new FaultPlan();
    const env = { clock, random: new SeededRandom(5), scheduler: freeScheduler, faults };
    const intents = new Map<string, { reason: string; amountCents?: unknown }>();
    const EXT: Record<string, string> = { DAMAGED: "DAMAGED_ITEM", NOT_DELIVERED: "NEVER_ARRIVED", CHANGED_MIND: "NO_LONGER_WANTED", OTHER: "OTHER" };
    const model = structured
      ? new ScriptedModel(() => new Error("model called on a structured request"))
      : new ScriptedModel((input) => {
      const it = intents.get(String(input.observations["request.message"]));
      const reason = it?.reason ?? "OTHER";
      return {
        operation: input.operation,
        contractVersion: input.contractVersion,
        decision: "PROPOSE_EFFECT",
        category: reason,
        effects: [{ tool: "payments.refund", args: { orderId: { ref: "order.id" }, amountCents: it?.amountCents !== undefined ? { value: it.amountCents } : { ref: "order.refundableCents" } } }],
      };
    });
    const secrets = new MemorySecretStore({ "psp.apiKey": "sk_test_psp_conf_0001", "ingress.signingKey": "conf-signing-key-0001" });
    const audit = new MemoryAudit();
    const app = buildRefundApp({ env, model, secrets, audit });
    const n = (sql: string, ...a: unknown[]) => app.db.prepare(sql).get(...a) as Record<string, number>;
    return {
      token: (p) => app.identity.issue({ subject: p.subject, tenant: p.tenant, scopes: p.scopes, sessionId: "conf" }, p.ttlMs ?? 600_000),
      async submit({ token, body, key }) {
        const { reason, amountCents, ...rest } = body as Record<string, unknown>;
        if (typeof rest.message === "string") intents.set(rest.message, { reason: String(reason), amountCents });
        const sent = structured ? { ...rest, ...(reason !== undefined ? { reason: EXT[String(reason)] ?? reason } : {}), ...(amountCents !== undefined ? { amountCents } : {}) } : rest;
        const r = await app.engine.handle({ principal: app.identity.verify(token), body: sent, idempotencyKey: key });
        if (structured && model.calls > 0) throw new Error("the model was called on a structured request");
        let kind: Kind;
        if (r.outcome === "ALLOW") kind = "ALLOW";
        else if (r.outcome === "REVIEW") kind = "REVIEW";
        // Tenancy: another tenant's order is invisible to the tenant-scoped tools, so the gate
        // reports its tenant fact as unestablished. That IS "not found" for this contract.
        else if (r.code === "UNVERIFIABLE_PRECONDITION" && /order\.tenantId is not established/.test(r.detail ?? "")) kind = "NOT_FOUND";
        else kind = KIND[r.code!] ?? "POLICY";
        return { kind, refundId: r.effect?.result.refundId as string | undefined, amountCents: r.effect?.result.amountCents as number | undefined, raw: r };
      },
      refundCount: () => n("SELECT COUNT(*) AS c FROM refunds").c!,
      balance: (id) => n("SELECT refundable_cents AS c FROM orders WHERE id=?", id).c!,
      outboxStatuses: () => (app.db.prepare("SELECT status FROM mn_outbox ORDER BY id").all() as { status: string }[]).map((r) => r.status),
      drain: async () => void (await app.dispatcher.drain()),
      advance: (ms) => clock.advance(ms),
      provider: { payments: () => app.psp.payments.size, calls: () => app.psp.calls, failNext: (k) => void (app.psp.failNext = k) },
      faults: { crashAfterSendOnce: () => void faults.arm("outbox.afterSend", "crash"), failNextCommit: () => void faults.arm("executor.beforeCommit", "db") },
      rotateSecret(value, accepts) {
        secrets.rotate("psp.apiKey", value);
        if (accepts) app.psp.acceptedKey = value;
      },
      secretValues: () => [secrets.get("psp.apiKey"), secrets.get("ingress.signingKey"), "sk_test_psp_conf_0001"],
      auditDump: () =>
        [...audit.records.map((r) => JSON.stringify(r)), ...(app.db.prepare("SELECT last_error FROM mn_outbox WHERE last_error IS NOT NULL").all() as { last_error: string }[]).map((r) => r.last_error)].join("\n"),
      close: () => {
        app.db.close();
      },
    };
  },
  };
}

export const modelnativImpl = makeImpl("modelnativ", false);
export const modelnativStructuredImpl = makeImpl("modelnativ-structured (no model)", true);
