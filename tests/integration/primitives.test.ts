import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PrimitiveConfigError, sqlEffect, sqlRead } from "@modelnativ/runtime";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE rewards (id TEXT PRIMARY KEY, tenant_id TEXT, stock INTEGER, cost INTEGER, active INTEGER);
          CREATE TABLE owners (id TEXT PRIMARY KEY, reward_id TEXT);
          INSERT INTO rewards VALUES ('rw_1','t_a',5,100,1); INSERT INTO owners VALUES ('o_1','rw_1');`);
  return d;
}
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PrimitiveConfigError);
    return (e as Error).message;
  }
  throw new Error("expected PrimitiveConfigError");
};

describe("sqlRead startup column checks", () => {
  const base = { name: "rewards.get", sql: "SELECT id, stock, cost FROM rewards WHERE id = ?", params: ["id"] };

  it("an unknown column fails at construction, with the result columns and the nearest name", () => {
    const m = err(() => sqlRead(db(), { ...base, facts: { "reward.stock": "stok" } }));
    expect(m).toContain('fact "reward.stock" maps column "stok", which the query does not return');
    expect(m).toContain("Result columns: id, stock, cost");
    expect(m).toContain('Did you mean "stock"?');
  });

  it("aliases are the column names: a mapped alias passes, the underlying name does not", () => {
    const q = { ...base, sql: "SELECT id AS reward_id, stock AS units FROM rewards WHERE id = ?" };
    expect(() => sqlRead(db(), { ...q, facts: { "reward.id": "reward_id", "reward.stock": "units" } })).not.toThrow();
    expect(err(() => sqlRead(db(), { ...q, facts: { "reward.stock": "stock" } }))).toContain("Result columns: reward_id, units");
  });

  it("an unaliased expression is named by its text; the error says to alias it", () => {
    const q = { ...base, sql: "SELECT COUNT(*) FROM rewards WHERE id = ?" };
    const m = err(() => sqlRead(db(), { ...q, facts: { "count.n": "n" } }));
    expect(m).toContain('Unaliased expressions (COUNT(*)) are named by their text: add "AS n"');
  });

  it("a referenced column returned twice (JOIN) is ambiguous", () => {
    const q = { ...base, sql: "SELECT r.id, o.id FROM rewards r JOIN owners o ON o.reward_id = r.id WHERE r.id = ?" };
    expect(err(() => sqlRead(db(), { ...q, facts: { "reward.id": "id" } }))).toMatch(/column "id" is returned 2 times \(from rewards, owners\).*Alias one/);
  });

  it("a booleans entry must be a result column too", () => {
    expect(err(() => sqlRead(db(), { ...base, booleans: ["activ"], facts: { "reward.id": "id" } }))).toContain('booleans entry "activ"');
  });

  it("SQL that does not prepare (unknown column in WHERE) fails at construction with the statement", () => {
    expect(err(() => sqlRead(db(), { ...base, sql: "SELECT id FROM rewards WHERE idd = ?", facts: { "reward.id": "id" } }))).toMatch(/does not prepare: no such column: idd/);
  });

  it("a table that does not exist yet defers the same checks to first use", async () => {
    const d = new Database(":memory:");
    const t = sqlRead(d, { ...base, facts: { "reward.stock": "stok" } }); // no throw: schema comes later
    d.exec("CREATE TABLE rewards (id TEXT PRIMARY KEY, stock INTEGER, cost INTEGER)");
    await expect(t.read({ id: "rw_1" }, {} as never)).rejects.toThrow(/maps column "stok".*Did you mean "stock"/s);
    const ok = sqlRead(new Database(":memory:"), { ...base, facts: { "reward.stock": "stock" } });
    await expect(ok.read({ id: "x" }, {} as never)).rejects.toThrow(/no such table: rewards/); // still missing at first use: actionable
  });
});

describe("sqlRead multi-fact derive", () => {
  it("computes once per read and provides every declared fact", async () => {
    let calls = 0;
    const t = sqlRead(db(), {
      name: "rewards.get", sql: "SELECT id, stock, cost FROM rewards WHERE id = ?", params: ["id"], facts: { "reward.id": "id" },
      derive: [{ facts: ["reward.value", "reward.big", "reward.none"], compute: (r) => (calls++, { "reward.value": Number(r.stock) * Number(r.cost), "reward.big": Number(r.cost) > 50, "reward.none": null }) }],
    });
    expect(t.provides).toEqual(["reward.id", "reward.value", "reward.big", "reward.none"]);
    expect(await t.read({ id: "rw_1" }, {} as never)).toEqual({ "reward.id": "rw_1", "reward.value": 500, "reward.big": true }); // null -> absent
    expect(calls).toBe(1);
  });
  it("a derive that returns an undeclared fact is an error; a fact declared twice is an error", async () => {
    const t = sqlRead(db(), { name: "x", sql: "SELECT id FROM rewards WHERE id = ?", params: ["id"], facts: {}, derive: [{ facts: ["a.b"], compute: () => ({ "a.c": 1 }) }] });
    await expect(t.read({ id: "rw_1" }, {} as never)).rejects.toThrow(/derive returned "a.c", which it does not declare/);
    expect(err(() => sqlRead(db(), { name: "x", sql: "SELECT id FROM rewards WHERE id = ?", params: ["id"], facts: { "a.b": "id" }, derive: [{ facts: ["a.b"], compute: () => ({}) }] }))).toContain('fact "a.b" is declared twice');
  });
});

describe("sqlEffect startup preparation", () => {
  it("validate() rejects a step whose SQL does not prepare, naming the step", () => {
    const a = sqlEffect({ tool: "t", steps: [{ insert: "INSERT INTO owners (id, reward_id) VALUES (?, ?)", params: () => ["o_2", "rw_1"] }, { write: "UPDATE rewards SET stok = stok - 1 WHERE id = ?", params: () => ["rw_1"], refuse: { code: "INVARIANT_VIOLATION" } }], result: () => ({}) });
    expect(err(() => a.validate(db()))).toMatch(/sqlEffect t: step 2 does not prepare: no such column: stok/);
  });
  it("statements are prepared once per connection, not per commit", () => {
    const d = db();
    let prepares = 0;
    const real = d.prepare.bind(d);
    (d as { prepare: unknown }).prepare = (q: string) => (prepares++, real(q));
    const a = sqlEffect({ tool: "t", steps: [{ write: "UPDATE rewards SET stock = stock - 1 WHERE id = ?", params: () => ["rw_1"], refuse: { code: "INVARIANT_VIOLATION" } }], result: () => ({ ok: true }) });
    a.validate(d);
    for (let i = 0; i < 3; i++) a.apply(d, {}, {} as never, { effectId: `e${i}`, now: 0 });
    expect(prepares).toBe(1);
  });
});
