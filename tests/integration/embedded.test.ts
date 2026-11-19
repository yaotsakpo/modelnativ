import { KeywordModel } from "@modelnativ/example-refund-migrated";
/**
 * Embedded adoption (architecture update §1, §5, §6, §8): replace ONE business
 * function inside the existing Express app. The controller, database, auth and
 * routes are the original's; only the injected RefundService changes, and its
 * behaviour is chosen by mode: legacy -> shadow -> modelnativ -> (rollback) legacy.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { buildRefundApp, seed } from "@modelnativ/example-refund-migrated";
import { createLegacyRefundService, createOriginalApp, type RefundRequest, type RefundResponse, type User } from "@modelnativ/example-refund-original";
import { createModelnativ, MemoryShadowSink, type Mode } from "@modelnativ/core";
import { ScriptedModel, type ModelAdapter } from "@modelnativ/model-adapter";
import { SeededRandom, testEnv } from "@modelnativ/runtime";
import { effectsState, fullRefund, propose } from "../helpers.ts";

const USERS: Record<string, User> = { "tok-alice": { id: "u_alice", tenantId: "t_acme" }, "tok-bob": { id: "u_bob", tenantId: "t_acme" } };

function host(model: ModelAdapter, mode: Mode) {
  const env = testEnv(3);
  const db = new Database(":memory:");
  seed(db, env.clock.now());
  const ids = new SeededRandom(99);
  const legacy = createLegacyRefundService(db, () => env.clock.now(), () => ids.id("rf"));
  // Modelnativ shares the host's database; the host keeps its schema and data.
  const kernel = buildRefundApp({ env, model, db });
  const shadow = new MemoryShadowSink();
  const mn = createModelnativ([kernel.engine], { modes: { "refund.create": mode }, shadow });
  const service = {
    requestRefund: mn.bind("refund.create", (u: User, r: RefundRequest, k: string) => legacy.requestRefund(u, r, k), {
      // Explicit delegation: the host decides who the caller is and which scopes they hold.
      principal: (u) => ({ subject: u.id, tenant: u.tenantId, sessionId: "host-session", scopes: ["refund:request"], expiresAt: env.clock.now() + 60_000 }),
      input: (_u, r) => ({ orderId: r.orderId, message: r.message ?? `The customer selected the reason: ${r.reason}` }),
      idempotencyKey: (_u, _r, k) => k,
      output: (res): RefundResponse =>
        res.outcome === "ALLOW"
          ? { outcome: "ALLOW", amountCents: Number(res.effect!.result.amountCents), refundId: String(res.effect!.result.refundId) }
          : // A host without a clarification UI treats CLARIFY as REVIEW.
            { outcome: res.outcome === "CLARIFY" ? "REVIEW" : res.outcome, reason: String(res.code) },
      normalizeLegacy: (r) => ({ outcome: r.outcome, amount: r.outcome === "ALLOW" ? r.amountCents : null }),
      normalizeModelnativ: (r) => ({ outcome: r.outcome === "CLARIFY" ? "REVIEW" : r.outcome, amount: (r.effect?.result.amountCents as number | undefined) ?? (r.outcome === "ALLOW" ? null : null) }),
    }),
  };
  const app = createOriginalApp(db, () => env.clock.now(), (t) => (t ? USERS[t] ?? null : null), service); // controller unchanged
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const post = async (token: string, body: unknown, key: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/refunds`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as RefundResponse };
  };
  return { db, mn, shadow, post, close: () => server.close() };
}

describe("embedded: replace one function behind an unchanged controller", () => {
  it("legacy mode is the original behaviour", async () => {
    const h = host(new KeywordModel(), "legacy");
    try {
      const r = await h.post("tok-alice", { orderId: "ord_a1", reason: "CHANGED_MIND" }, "key-legacy-0001");
      expect(r).toMatchObject({ status: 201, body: { outcome: "ALLOW", amountCents: 12000 } });
      expect(effectsState(h.db).effects).toBe(0); // the kernel was never involved
    } finally {
      h.close();
    }
  });

  it("shadow mode: legacy stays authoritative, Modelnativ writes nothing, mismatches are recorded", async () => {
    const h = host(new KeywordModel(), "shadow");
    try {
      const calls: [string, RefundRequest][] = [
        ["tok-alice", { orderId: "ord_a1", reason: "CHANGED_MIND", message: "I changed my mind" }],
        ["tok-alice", { orderId: "ord_a2", reason: "DAMAGED", message: "it arrived broken" }],
        ["tok-alice", { orderId: "ord_a6", reason: "DAMAGED", message: "the box was crushed" }], // no carrier report
        ["tok-alice", { orderId: "ord_a3", reason: "CHANGED_MIND", message: "changed my mind" }], // 40 days
        ["tok-alice", { orderId: "ord_a4", reason: "NOT_DELIVERED", message: "Le colis n'est jamais arrivé" }], // keyword mock can't read French
      ];
      const legacyAllows: number[] = [];
      for (const [i, [tok, body]] of calls.entries()) {
        const r = await h.post(tok, body, `k-shadow-${i}`);
        if (r.body.outcome === "ALLOW") legacyAllows.push(i);
      }
      const st = effectsState(h.db);
      expect(st.refunds).toBe(legacyAllows.length); // only legacy wrote
      expect(st.effects).toBe(0); // Modelnativ committed nothing
      expect(st.outbox).toBe(0); // and dispatched nothing
      const rep = h.mn.shadowReport("refund.create");
      expect(rep.total).toBe(5);
      expect(rep.mismatches.map((m) => m.modelnativCode)).toEqual(["MODEL_REQUESTED_REVIEW"]); // the French message
      expect(JSON.stringify(h.shadow.records)).not.toContain("jamais"); // inputs are hashed, not stored
    } finally {
      h.close();
    }
  });

  it("modelnativ mode: same controller, the kernel decides and enforces", async () => {
    const h = host(new ScriptedModel(propose("CHANGED_MIND", { orderId: { ref: "order.id" }, amountCents: { value: 90000 } })), "modelnativ");
    try {
      const r = await h.post("tok-alice", { orderId: "ord_big", reason: "CHANGED_MIND", message: "refund $900" }, "key-mn-0001");
      expect(r).toMatchObject({ status: 422, body: { outcome: "REFUSE", reason: "INVARIANT_VIOLATION" } });
      expect(effectsState(h.db).refunds).toBe(0);
    } finally {
      h.close();
    }
  });

  it("rollback is a mode switch", async () => {
    const h = host(new KeywordModel(), "modelnativ");
    try {
      const a = await h.post("tok-alice", { orderId: "ord_a6", reason: "DAMAGED", message: "box crushed" }, "key-rb-0001");
      expect(a.body.outcome).toBe("REVIEW"); // kernel: damage not established by the carrier
      h.mn.setMode("refund.create", "legacy");
      const b = await h.post("tok-alice", { orderId: "ord_a6", reason: "CHANGED_MIND" }, "key-rb-0002");
      expect(b.body).toMatchObject({ outcome: "ALLOW", amountCents: 7000 }); // original logic again
    } finally {
      h.close();
    }
  });

  it("fallback: a model failure falls back to legacy; a policy refusal never does", async () => {
    const broken = new ScriptedModel(() => new Error("model crashed"));
    const h = host(broken, "fallback");
    try {
      const a = await h.post("tok-alice", { orderId: "ord_a1", reason: "CHANGED_MIND" }, "key-fb-0001");
      expect(a.body).toMatchObject({ outcome: "ALLOW", amountCents: 12000 }); // legacy served it
      expect(effectsState(h.db).effects).toBe(0);
    } finally {
      h.close();
    }
    const h2 = host(new ScriptedModel(propose("CHANGED_MIND", fullRefund)), "fallback");
    try {
      const b = await h2.post("tok-alice", { orderId: "ord_b1", reason: "CHANGED_MIND" }, "key-fb-0002"); // bob's order
      expect(b.body).toMatchObject({ outcome: "REFUSE", reason: "CAPABILITY_MISSING" });
      expect(effectsState(h2.db).refunds).toBe(0); // legacy (which would also refuse) was not consulted
    } finally {
      h2.close();
    }
  });
});
