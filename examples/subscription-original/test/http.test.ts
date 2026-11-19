import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { HttpBillingProvider } from "../src/billing-provider.ts";
import type { Caller } from "../src/service.ts";
import { admin, member, otherTenantAdmin, setup, subscriptionRow } from "./helpers.ts";

const tokens = new Map<string, Caller>([
  ["tok_admin", admin],
  ["tok_member", member],
  ["tok_other", otherTenantAdmin],
]);

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(seedOpts = {}, config = {}) {
  const h = setup(seedOpts, config);
  const app = createApp({ service: h.service, tokens });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { ...h, post };
}

describe("POST /subscriptions/:id/plan-change", () => {
  it("returns 401 without a valid bearer token", async () => {
    const { post } = await start();
    expect((await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" })).status).toBe(401);
    expect((await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" }, "bogus")).status).toBe(401);
  });

  it("returns 400 for an invalid body", async () => {
    const { post } = await start();
    expect((await post("/subscriptions/sub_a/plan-change", {}, "tok_admin")).status).toBe(400);
    expect((await post("/subscriptions/sub_a/plan-change", { targetPlanId: "" }, "tok_admin")).status).toBe(400);
    expect((await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter", extra: 1 }, "tok_admin")).status).toBe(400);
    expect((await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter", expectedVersion: 1.5 }, "tok_admin")).status).toBe(400);
    expect((await post("/subscriptions/sub_a/plan-change", "{not json", "tok_admin")).status).toBe(400);
  });

  it("returns 200 with the change result", async () => {
    const { post, db } = await start();
    const res = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter", expectedVersion: 1 }, "tok_admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "changed", prorationCents: -4_667, version: 2 });
    expect(subscriptionRow(db).plan_id).toBe("plan_starter");
  });

  it("returns 202 for pending approval", async () => {
    const { post } = await start();
    const res = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_business" }, "tok_admin");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending_approval", prorationCents: 26_667 });
  });

  it("maps rejections to 403 / 404 / 422 with the reason code", async () => {
    const { post } = await start({ seatsInUse: 50 });
    const forbidden = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" }, "tok_member");
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { status: "rejected", reason: "forbidden" }]);
    const notFound = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" }, "tok_other");
    expect([notFound.status, await notFound.json()]).toEqual([404, { status: "rejected", reason: "not_found" }]);
    const seats = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" }, "tok_admin");
    expect([seats.status, await seats.json()]).toEqual([422, { status: "rejected", reason: "seat_limit_exceeded" }]);
  });

  it("returns 409 on a version conflict", async () => {
    const { post } = await start();
    const res = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter", expectedVersion: 9 }, "tok_admin");
    expect([res.status, await res.json()]).toEqual([409, { status: "rejected", reason: "version_conflict" }]);
  });

  it("returns 500 when the transaction fails", async () => {
    const { post, db } = await start();
    db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON plan_change_history BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/subscriptions/sub_a/plan-change", { targetPlanId: "plan_starter" }, "tok_admin");
    expect(res.status).toBe(500);
    expect(subscriptionRow(db).plan_id).toBe("plan_pro");
    spy.mockRestore();
  });
});

describe("HttpBillingProvider", () => {
  const event = {
    subscriptionId: "sub_a",
    accountId: "acct_a",
    fromPlanId: "plan_pro",
    toPlanId: "plan_starter",
    direction: "downgrade" as const,
    prorationCents: -4_667,
    version: 2,
    changedAt: "2026-03-11T00:00:00.000Z",
  };

  it("POSTs the event with auth and an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await new HttpBillingProvider("https://billing.example", "key_123", fetchImpl as unknown as typeof fetch).notifyPlanChanged(event);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://billing.example/v1/subscriptions/sub_a/plan-changed");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer key_123", "idempotency-key": "sub_a:2" });
    expect(JSON.parse(init.body as string)).toEqual(event);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(
      new HttpBillingProvider("https://billing.example", "k", fetchImpl as unknown as typeof fetch).notifyPlanChanged(event),
    ).rejects.toThrow("503");
  });
});
