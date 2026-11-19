/**
 * Audit finding R3: the dispatcher overlapped itself (serve calls drain() every second) and rows
 * were not leased across processes. Now: single-flight per dispatcher, a lease per row.
 * Delivery stays at-least-once: these tests count sends, and never claim exactly-once.
 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OUTBOX_LEASE_MS, Dispatcher, MemorySecretStore, type Destination } from "@modelnativ/effect-executor";
import { FaultPlan, NO_FAULTS, VirtualClock } from "@modelnativ/runtime";

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);

/** A destination whose sends complete when the test says so; counts calls and de-duplicates like a real receiver. */
function receiver() {
  const pending: (() => void)[] = [];
  const seen = new Set<string>();
  let calls = 0;
  let hold = false;
  const dest: Destination = {
    name: "x",
    secrets: [],
    send: async (_p, ctx) => {
      calls++;
      if (hold) await new Promise<void>((r) => pending.push(r));
      seen.add(ctx.idempotencyKey);
      return { externalId: `ext_${ctx.idempotencyKey}` };
    },
  };
  return { dest, get calls() { return calls; }, effects: () => seen.size, hold: (h: boolean) => void (hold = h), release: () => pending.splice(0).forEach((r) => r()) };
}
function sharedFile(rows: number) {
  const f = join(mkdtempSync(join(tmpdir(), "mn-outbox-")), "app.db");
  const db = new Database(f);
  db.pragma("journal_mode = WAL");
  new Dispatcher(db, new VirtualClock(T0), NO_FAULTS, new MemorySecretStore({}), []); // creates the schema
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO mn_outbox(id, effect_id, destination, payload_json, status, next_attempt_at) VALUES (?,?,?,?, 'pending', ?)").run(`o${i}`, `eff_${i}`, "x", "{}", T0);
  db.close();
  return f;
}
const open = (f: string) => {
  const db = new Database(f);
  db.pragma("busy_timeout = 5000");
  return db;
};
const statuses = (db: Database.Database) => (db.prepare("SELECT status FROM mn_outbox ORDER BY id").all() as { status: string }[]).map((r) => r.status);
const tick = () => new Promise((r) => setImmediate(r));

describe("outbox dispatch: single-flight and row leases", () => {
  it("overlapping drain() calls in one process send each row once (was: twice, audit probe P4)", async () => {
    const f = sharedFile(3);
    const rx = receiver();
    rx.hold(true);
    const d = new Dispatcher(open(f), new VirtualClock(T0), NO_FAULTS, new MemorySecretStore({}), [rx.dest]);
    const a = d.drain();
    const b = d.drain(); // e.g. the next setInterval tick while the first drain is still sending
    expect(b).toBe(a);
    for (let i = 0; i < 3; i++) (await tick(), rx.release());
    await Promise.all([a, b]);
    expect(rx.calls).toBe(3);
  });

  it("two dispatchers (two processes) on one database never send the same row concurrently", async () => {
    const f = sharedFile(20);
    const clock = new VirtualClock(T0);
    const rx = receiver();
    const d1 = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [rx.dest]);
    const d2 = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [rx.dest]);
    const [r1, r2] = await Promise.all([d1.drain(), d2.drain()]);
    expect(r1.delivered + r2.delivered).toBe(20);
    expect(rx.calls).toBe(20);
    expect(statuses(open(f)).every((s) => s === "delivered")).toBe(true);
  });

  it("crash after send: a new process does not resend before the lease expires, then resends once (at-least-once)", async () => {
    const f = sharedFile(1);
    const clock = new VirtualClock(T0);
    const rx = receiver();
    const crashing = new Dispatcher(open(f), clock, new FaultPlan().arm("outbox.afterSend", "crash"), new MemorySecretStore({}), [rx.dest]);
    await expect(crashing.drain()).rejects.toThrow(/crash/);
    expect(rx.calls).toBe(1);
    const restarted = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [rx.dest]); // new owner
    expect((await restarted.drain()).delivered).toBe(0); // the crashed dispatcher's lease is still live
    expect(rx.calls).toBe(1);
    clock.advance(DEFAULT_OUTBOX_LEASE_MS);
    expect((await restarted.drain()).delivered).toBe(1);
    expect(rx.calls).toBe(2); // sent twice...
    expect(rx.effects()).toBe(1); // ...one effect at the de-duplicating receiver
    expect(statuses(open(f))).toEqual(["delivered"]);
  });

  it("a send slower than the lease: another dispatcher takes over; the late ack is fenced (leaseLost), not recorded twice", async () => {
    const f = sharedFile(1);
    const clock = new VirtualClock(T0);
    const slow = receiver();
    slow.hold(true);
    const fast = receiver();
    const d1 = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [slow.dest], { leaseMs: 1_000 });
    const d2 = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [fast.dest], { leaseMs: 1_000 });
    const p1 = d1.drain();
    await tick();
    clock.advance(1_000); // d1's lease expires while its send hangs
    expect((await d2.drain()).delivered).toBe(1);
    slow.release();
    expect(await p1).toMatchObject({ delivered: 0, leaseLost: 1 });
    const db = open(f);
    expect(db.prepare("SELECT status, external_id, attempts FROM mn_outbox").get()).toEqual({ status: "delivered", external_id: "ext_eff_0", attempts: 1 });
    expect(slow.calls + fast.calls).toBe(2); // the duplicate send is the documented at-least-once cost
  });

  it("retries and dead letters still work, and release the lease", async () => {
    const f = sharedFile(1);
    const clock = new VirtualClock(T0);
    let calls = 0;
    const flaky: Destination = { name: "x", secrets: [], send: async () => { calls++; throw Object.assign(new Error("503"), { retryable: true }); } };
    const policy = { maxAttempts: 2, baseMs: 100, maxMs: 1_000, jitter: "none" as const };
    const d = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [flaky], { policy });
    expect(await d.drain()).toMatchObject({ retried: 1 });
    const other = new Dispatcher(open(f), clock, NO_FAULTS, new MemorySecretStore({}), [flaky], { policy });
    clock.advance(200);
    expect(await other.drain()).toMatchObject({ dead: 1 }); // lease was released: another process can retry at once
    expect(calls).toBe(2);
    expect(open(f).prepare("SELECT status, lease_owner FROM mn_outbox").get()).toEqual({ status: "dead", lease_owner: null });
  });

  it("an outbox table from an older version gains the lease columns", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE mn_outbox (id TEXT PRIMARY KEY, effect_id TEXT NOT NULL, destination TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, external_id TEXT, last_error TEXT)");
    new Dispatcher(db, new VirtualClock(T0), NO_FAULTS, new MemorySecretStore({}), []);
    const cols = (db.prepare("PRAGMA table_info(mn_outbox)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("lease_owner");
    expect(cols).toContain("lease_until");
  });
});
