/**
 * The advertised subscription demos work as documented (README / QUICKSTART):
 * - `modelnativ serve` refuses to start without a signing key (no well-known default key)
 * - `modelnativ serve --dev` prints a demo token for the seeded admin; the printed request succeeds
 * - the embedded SDK serves the ORIGINAL Express app; the same request succeeds there
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const procs: ChildProcess[] = [];
afterAll(() => procs.forEach((p) => p.kill()));

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const p = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  const until = (re: RegExp, ms = 30_000) =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}; output:\n${out}`)), ms);
      const check = () => {
        const m = out.match(re);
        if (m) (clearTimeout(t), resolve(m));
      };
      p.stdout!.on("data", check);
      p.stderr!.on("data", check);
      check();
    });
  const exit = new Promise<number | null>((r) => p.on("close", r));
  return { p, until, exit, output: () => out };
}

describe("subscription demos", { timeout: 60_000 }, () => {
  it("serve without MN_SECRET_INGRESS_SIGNINGKEY refuses to start", async () => {
    const r = run(["packages/cli/src/main.ts", "serve", "examples/subscription-original/modelnativ/c", "--port", "0"], { MN_SECRET_INGRESS_SIGNINGKEY: undefined });
    expect(await r.exit).not.toBe(0);
    expect(r.output()).toContain("MN_SECRET_INGRESS_SIGNINGKEY is not set");
  });

  it("serve --dev: the printed token and request change the plan (201), and a replay is a duplicate (200)", async () => {
    const r = run(["packages/cli/src/main.ts", "serve", "examples/subscription-original/modelnativ/c", "--dev", "--port", "0"], { MN_SECRET_INGRESS_SIGNINGKEY: undefined });
    const [, token] = await r.until(/demo token \(subject user_admin, tenant tenant_a, 1h\):\n\s+(mn1\.\S+)/);
    const port = r.output().match(/^on :(\d+)/m)![1];
    const send = () => fetch(`http://127.0.0.1:${port}/v1/plan.change`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-test-0001", "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: "sub_a", targetPlanId: "plan_starter" }) });
    const first = await send();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ outcome: "ALLOW", effect: { status: "committed", result: { status: "changed", toPlanId: "plan_starter", version: 2 } } });
    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ effect: { status: "duplicate" } });
    const forged = await fetch(`http://127.0.0.1:${port}/v1/plan.change`, { method: "POST", headers: { authorization: "Bearer mn1.e30.forged", "idempotency-key": "demo-test-0002", "content-type": "application/json" }, body: "{}" });
    expect(forged.status).toBe(401);
  });

  it("embedded demo: the original Express app with Modelnativ inside answers like the original (200 changed)", async () => {
    const r = run(["examples/subscription-original/demo-embedded.ts"], { PORT: "0" });
    const [cmd, port] = await r.until(/curl -s localhost:(\d+)\S* .*/);
    const token = cmd.match(/Bearer (\w+)/)![1];
    const res = await fetch(`http://127.0.0.1:${port}/subscriptions/sub_a/plan-change`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ targetPlanId: "plan_starter" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "changed", fromPlanId: "plan_pro", toPlanId: "plan_starter", direction: "downgrade", version: 2 });
    await r.until(/billing <- .*"toPlanId":"plan_starter"/);
  });
});
