/**
 * The conformance suite. Both Modelnativ and the traditional implementation must
 * pass it unchanged before their code size is compared.
 */
import { describe, expect, it } from "vitest";
import type { Instance, RefundBody, RefundImpl } from "./types.ts";

const START = Date.UTC(2026, 10, 16, 12, 0, 0);
let n = 0;
const msg = (s: string) => `${s} [req ${++n}]`;

export function conformanceSuite(impl: RefundImpl) {
  async function withInstance(fn: (i: Instance, alice: string) => Promise<void>) {
    const i = await impl.create({ clockStart: START });
    try {
      await fn(i, i.token({ subject: "u_alice", tenant: "t_acme", scopes: ["refund:request"] }));
    } finally {
      await i.close();
    }
  }
  const body = (b: Partial<RefundBody> & Pick<RefundBody, "orderId" | "reason">): RefundBody => ({ message: msg("please refund"), ...b });

  describe(`${impl.name}: identity and scope`, () => {
    it("rejects missing, forged and expired credentials and missing scope, with no effect", () =>
      withInstance(async (i, alice) => {
        const b = body({ orderId: "ord_a1", reason: "CHANGED_MIND" });
        expect((await i.submit({ token: null, body: b, key: "conf-key-0001" })).kind).toBe("UNAUTHENTICATED");
        const forged = alice.slice(0, -2) + (alice.at(-2) === "A" ? "B" : "A") + alice.at(-1);
        expect((await i.submit({ token: forged, body: b, key: "conf-key-0001" })).kind).toBe("UNAUTHENTICATED");
        const short = i.token({ subject: "u_alice", tenant: "t_acme", scopes: ["refund:request"], ttlMs: 1000 });
        i.advance(2000);
        expect((await i.submit({ token: short, body: b, key: "conf-key-0001" })).kind).toBe("UNAUTHENTICATED");
        const noScope = i.token({ subject: "u_alice", tenant: "t_acme", scopes: ["orders:read"] });
        expect((await i.submit({ token: noScope, body: b, key: "conf-key-0001" })).kind).toBe("FORBIDDEN");
        expect(i.refundCount()).toBe(0);
      }));
  });

  describe(`${impl.name}: ownership and tenancy`, () => {
    it("refuses another user's order and hides another tenant's order", () =>
      withInstance(async (i, alice) => {
        const r1 = await i.submit({ token: alice, body: body({ orderId: "ord_b1", reason: "CHANGED_MIND" }), key: "conf-key-0002" });
        expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r1.kind);
        const r2 = await i.submit({ token: alice, body: body({ orderId: "ord_g1", reason: "CHANGED_MIND" }), key: "conf-key-0003" });
        expect(r2.kind).toBe("NOT_FOUND");
        expect(JSON.stringify(r2.raw)).not.toMatch(/u_gina|t_globex|5000/);
        expect(i.refundCount()).toBe(0);
      }));
  });

  describe(`${impl.name}: input`, () => {
    it("rejects malformed input, smuggled identity fields and missing idempotency keys", () =>
      withInstance(async (i, alice) => {
        expect((await i.submit({ token: alice, body: { reason: "CHANGED_MIND", message: msg("x") }, key: "conf-key-0004" })).kind).toBe("INVALID");
        expect((await i.submit({ token: alice, body: { ...body({ orderId: "ord_b1", reason: "CHANGED_MIND" }), principal: "u_bob" }, key: "conf-key-0005" })).kind).toBe("INVALID");
        expect((await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: null })).kind).toBe("INVALID");
        expect((await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND", amountCents: 12.5 }), key: "conf-key-0006" })).kind).toBe("INVALID");
        expect(i.refundCount()).toBe(0);
      }));
  });

  describe(`${impl.name}: policy`, () => {
    const table: [string, RefundBody["reason"], Partial<RefundBody>, string, number?][] = [
      ["ord_a1", "CHANGED_MIND", {}, "ALLOW", 12000],
      ["ord_a3", "CHANGED_MIND", {}, "POLICY"], // 40 days
      ["ord_a2", "DAMAGED", {}, "ALLOW", 4500], // carrier confirms damage
      ["ord_a6", "DAMAGED", {}, "REVIEW"], // no carrier report
      ["ord_a6", "DAMAGED", { claims: { damaged: true } }, "REVIEW"], // the customer's claim is not a fact
      ["ord_a1", "DAMAGED", {}, "REVIEW"],
      ["ord_a4", "NOT_DELIVERED", {}, "ALLOW", 2500],
      ["ord_a1", "NOT_DELIVERED", { claims: { delivered: false } }, "POLICY"], // carrier says delivered
      ["ord_a6", "OTHER", {}, "REVIEW"],
      ["ord_big", "CHANGED_MIND", {}, "POLICY"], // 90000 > 50000 cap
      ["ord_a1", "CHANGED_MIND", { amountCents: 13000 }, "POLICY"], // > balance
      ["ord_a1", "CHANGED_MIND", { amountCents: 0 }, "POLICY"],
      ["ord_a1", "CHANGED_MIND", { amountCents: 3000 }, "ALLOW", 3000],
    ];
    for (const [orderId, reason, extra, kind, amount] of table)
      it(`${orderId} ${reason} ${JSON.stringify(extra)} -> ${kind}`, () =>
        withInstance(async (i, alice) => {
          const r = await i.submit({ token: alice, body: body({ orderId, reason, ...extra }), key: "conf-key-0010" });
          expect(r.kind).toBe(kind);
          if (kind === "ALLOW") {
            expect(r.amountCents).toBe(amount);
            expect(i.refundCount()).toBe(1);
          } else expect(i.refundCount()).toBe(0);
        }));
  });

  describe(`${impl.name}: idempotency`, () => {
    it("a duplicate returns the original refund and never duplicates the payment", () =>
      withInstance(async (i, alice) => {
        const b = body({ orderId: "ord_a1", reason: "CHANGED_MIND" });
        const a = await i.submit({ token: alice, body: b, key: "conf-dup-0001" });
        const c = await i.submit({ token: alice, body: b, key: "conf-dup-0001" });
        expect(a.kind).toBe("ALLOW");
        expect(c.kind).toBe("ALLOW");
        expect(c.refundId).toBe(a.refundId);
        await i.drain();
        expect(i.refundCount()).toBe(1);
        expect(i.provider.payments()).toBe(1);
      }));
    it("the same key for a different request is a CONFLICT", () =>
      withInstance(async (i, alice) => {
        await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND", amountCents: 100 }), key: "conf-dup-0002" });
        const r = await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND", amountCents: 200 }), key: "conf-dup-0002" });
        expect(r.kind).toBe("CONFLICT");
        expect(i.refundCount()).toBe(1);
      }));
    it("keys are scoped per caller", () =>
      withInstance(async (i, alice) => {
        const bob = i.token({ subject: "u_bob", tenant: "t_acme", scopes: ["refund:request"] });
        expect((await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: "conf-shared-01" })).kind).toBe("ALLOW");
        expect((await i.submit({ token: bob, body: body({ orderId: "ord_b1", reason: "CHANGED_MIND" }), key: "conf-shared-01" })).kind).toBe("ALLOW");
        expect(i.refundCount()).toBe(2);
      }));
  });

  describe(`${impl.name}: concurrency`, () => {
    it("two simultaneous $80 refunds against $100: never both", () =>
      withInstance(async (i, alice) => {
        const rs = await Promise.all(
          ["A", "B"].map((k) => i.submit({ token: alice, body: body({ orderId: "ord_acct", reason: "CHANGED_MIND", amountCents: 8000 }), key: `conf-race-${k}-001` })),
        );
        expect(rs.filter((r) => r.kind === "ALLOW")).toHaveLength(1);
        expect(i.balance("ord_acct")).toBe(2000);
      }));
    // HTTP-bound implementations take several seconds for 500 requests under a loaded test run.
    it("500 concurrent 50-cent refunds on 10000: exactly 200 succeed, balance 0", { timeout: 30_000 }, () =>
      withInstance(async (i, alice) => {
        const rs = await Promise.all(
          Array.from({ length: 500 }, (_, k) =>
            i.submit({ token: alice, body: body({ orderId: "ord_acct", reason: "CHANGED_MIND", amountCents: 50 }), key: `conf-load-${String(k).padStart(5, "0")}` }),
          ),
        );
        expect(rs.filter((r) => r.kind === "ALLOW")).toHaveLength(200);
        expect(rs.every((r) => ["ALLOW", "POLICY", "CONFLICT"].includes(r.kind))).toBe(true);
        expect(i.balance("ord_acct")).toBe(0);
        expect(i.refundCount()).toBe(200);
      }));
  });

  describe(`${impl.name}: recovery`, () => {
    it("a commit failure rolls back; the retry succeeds once", () =>
      withInstance(async (i, alice) => {
        i.faults.failNextCommit();
        const b = body({ orderId: "ord_a1", reason: "CHANGED_MIND" });
        expect((await i.submit({ token: alice, body: b, key: "conf-rec-0001" })).kind).toBe("UNAVAILABLE");
        expect(i.refundCount()).toBe(0);
        expect(i.outboxStatuses()).toEqual([]);
        expect((await i.submit({ token: alice, body: b, key: "conf-rec-0001" })).kind).toBe("ALLOW");
        expect(i.refundCount()).toBe(1);
      }));
    it("a worker crash after the provider accepted: one payment after restart", () =>
      withInstance(async (i, alice) => {
        await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: "conf-rec-0002" });
        i.faults.crashAfterSendOnce();
        await expect(i.drain()).rejects.toThrow();
        await i.drain();
        expect(i.provider.payments()).toBe(1);
        expect(i.provider.calls()).toBe(2);
        expect(i.outboxStatuses()).toEqual(["delivered"]);
      }));
    it("provider outages are retried with backoff, then dead-lettered", () =>
      withInstance(async (i, alice) => {
        await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: "conf-rec-0003" });
        i.provider.failNext(2);
        await i.drain();
        await i.drain(); // not due yet: no extra call
        expect(i.provider.calls()).toBe(1);
        for (let k = 0; k < 3; k++) {
          i.advance(60_000);
          await i.drain();
        }
        expect(i.provider.payments()).toBe(1);
        expect(i.outboxStatuses()).toEqual(["delivered"]);

        await i.submit({ token: alice, body: body({ orderId: "ord_a2", reason: "DAMAGED" }), key: "conf-rec-0004" });
        i.provider.failNext(99);
        for (let k = 0; k < 8; k++) {
          await i.drain();
          i.advance(120_000);
        }
        expect(i.outboxStatuses().sort()).toEqual(["dead", "delivered"]);
      }));
  });

  describe(`${impl.name}: audit and secrets`, () => {
    it("every decision is audited; free text and secrets never appear in audit output", () =>
      withInstance(async (i, alice) => {
        const secretMsg = msg("my card number is 4111111111111111 and I changed my mind");
        await i.submit({ token: alice, body: { orderId: "ord_a1", reason: "CHANGED_MIND", message: secretMsg }, key: "conf-aud-0001" });
        await i.submit({ token: alice, body: body({ orderId: "ord_b1", reason: "CHANGED_MIND" }), key: "conf-aud-0002" });
        await i.submit({ token: null, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: "conf-aud-0003" });
        i.rotateSecret("sk_wrong_conf_7777", false);
        await i.drain(); // provider rejects the key; the error must be scrubbed
        const dump = i.auditDump();
        expect(dump).not.toContain("4111111111111111");
        expect(dump).not.toContain(secretMsg);
        for (const s of [...i.secretValues(), "sk_wrong_conf_7777"]) expect(dump).not.toContain(s);
        expect(dump.match(/ALLOW|allow/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(dump.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);
      }));
    it("secret rotation takes effect without a restart", () =>
      withInstance(async (i, alice) => {
        await i.submit({ token: alice, body: body({ orderId: "ord_a1", reason: "CHANGED_MIND" }), key: "conf-rot-0001" });
        i.rotateSecret("sk_rotated_conf_0002", true);
        await i.drain();
        expect(i.provider.payments()).toBe(1);
      }));
  });
}
