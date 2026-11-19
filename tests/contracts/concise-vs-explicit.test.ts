import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { ContractError, compileContract, expandShorthand, explainShorthand } from "@modelnativ/contract-compiler";
import { compare } from "./concise-vs-explicit.lib.ts";

const ROOT = join(import.meta.dirname, "../..");
const PAIRS = [
  ["loyalty", "examples/loyalty-original/modelnativ/c/loyalty.redeem.yaml", "examples/loyalty-original/modelnativ/loyalty.redeem.yaml"],
  ["refund", "examples/refund-original/modelnativ/c/refund.request.yaml", "examples/refund-original/modelnativ/refund.request.yaml"],
  ["subscription", "examples/subscription-original/modelnativ/c/plan.change.yaml", "examples/subscription-original/modelnativ/a/plan.change.yaml"],
] as const;
const load = (f: string) => YAML.parse(readFileSync(join(ROOT, f), "utf8"));
const problems = (doc: unknown) => {
  try {
    compileContract(doc);
    return [];
  } catch (e) {
    if (e instanceof ContractError) return e.problems;
    throw e;
  }
};

describe("concise (C) expands to the explicit (A) contract", () => {
  for (const [name, c, a] of PAIRS)
    it(`${name}: identical except documentation fields and grant ids`, () => {
      expect(compare(join(ROOT, c), join(ROOT, a))).toEqual([]);
    });

  it("the comparison has teeth: a changed rule in the concise form is reported", () => {
    const doc = load(PAIRS[0][1]);
    doc.spec.decision.categories.REDEEM.requires[5] = { "today.count < 5": "daily_limit" };
    const f = join(mkdtempSync(join(tmpdir(), "mn-c-")), "x.yaml");
    writeFileSync(f, YAML.stringify(doc));
    expect(compare(f, join(ROOT, PAIRS[0][2])).join("\n")).toContain("today.count < 5");
  });
});

describe("shorthand activation is explicit", () => {
  it("an explicit contract missing a required block fails validation (no silent defaults)", () => {
    const doc = load(PAIRS[0][2]);
    delete doc.spec.failure;
    expect(problems(doc).join("\n")).toMatch(/failure/);
    expect(explainShorthand(doc)).toEqual([]);
  });

  it("concise syntax in a kind: Operation document is rejected with an actionable message", () => {
    const concise = load(PAIRS[0][1]);
    const p = problems({ ...concise, kind: "Operation" });
    expect(p.some((x) => x.startsWith("spec.reads is concise syntax (use kind: ConciseOperation"))).toBe(true);
    expect(p.some((x) => x.includes("requires[0]: the \"expr\": code rule form is concise syntax"))).toBe(true);
    expect(p.some((x) => x.includes("spec.effects.loyalty.redeem.apply.args.memberId: the short argument form"))).toBe(true);
  });

  it("every existing explicit contract in the repository compiles unchanged (backward compatibility)", () => {
    const yamls = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === "node_modules" ? [] : yamls(join(d, n))) : n.endsWith(".yaml") ? [join(d, n)] : []));
    const explicit = yamls(join(ROOT, "examples")).filter((f) => !f.includes("/generated/") && YAML.parse(readFileSync(f, "utf8"))?.kind === "Operation");
    expect(explicit.length).toBeGreaterThanOrEqual(7);
    for (const f of explicit) {
      const doc = YAML.parse(readFileSync(f, "utf8"));
      expect(explainShorthand(doc)).toEqual([]);
      expect(problems(doc)).toEqual([]);
    }
  });

  it("a concise contract compiles to the same hash as its expansion written out by hand", () => {
    const concise = load(PAIRS[1][1]);
    expect(compileContract(concise).hash).toBe(compileContract(expandShorthand(concise)).hash);
  });

  it("--explain lists every default and expansion, with the path it wrote", () => {
    const notes = explainShorthand(load(PAIRS[0][1]));
    expect(notes.some((n) => n.startsWith("spec.failure") && n.includes("default"))).toBe(true);
    expect(notes.some((n) => n.includes("reads") && n.includes("cap.rewards.get"))).toBe(true);
    expect(notes.some((n) => n.includes("args.quantity") && n.includes("type: integer"))).toBe(true);
  });
});
