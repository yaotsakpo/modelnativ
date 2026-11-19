import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicatedConstants } from "@modelnativ/analyzer-typescript";

const ROOT = join(import.meta.dirname, "../..");

describe("lint: business constants duplicated between contract rules and adapter code", () => {
  it("finds a literal and a named constant that repeat a rule's number", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-lint-"));
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "op.yaml"), 'kind: Operation\nspec:\n  decision:\n    categories:\n      X: { requires: [{ rule: "today.count < 3", code: daily_limit }, "order.ageDays <= 30"] }\n  policy: { preconditions: ["a.n >= 1"] }\n');
    writeFileSync(join(d, "adapters.ts"), "const DAILY_LIMIT = 3;\nexport const f = (n: number) => { if (n >= DAILY_LIMIT) throw new Error(); };\n// a comment: 30 < x\n");
    writeFileSync(join(d, "b", "adapters.ts"), "export const g = (r: { n: number }) => Number(r.n) < 3;\nexport const h = (x: number) => x <= 30;\nexport const k = (x: number) => x >= 1;\n");
    const found = findDuplicatedConstants(d).map((x) => `${x.value} ${x.code.file}:${x.code.line}`).sort();
    expect(found).toEqual(["3 adapters.ts:2", "3 b/adapters.ts:1", "30 b/adapters.ts:2"]); // 1 ignored, comments ignored
  });
  it("the migrated examples have none (the loyalty daily limit is now one policy fact)", () => {
    for (const d of ["examples/loyalty-original/modelnativ", "examples/refund-original/modelnativ", "examples/subscription-original/modelnativ"]) expect(findDuplicatedConstants(join(ROOT, d))).toEqual([]);
  });
});
