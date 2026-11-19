import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftContract, extract, inspect } from "@modelnativ/analyzer-typescript";

const ROOT = join(import.meta.dirname, "..", "..");
const REFUND = join(ROOT, "examples/refund-original/src");
const LOYALTY = join(ROOT, "examples/loyalty-original/src");

/** Every reported location must point at source that contains what was reported. */
function provenanceHolds(dir: string, file: string, line: number, needle: string) {
  const src = readFileSync(join(dir, file), "utf8").split("\n")[line - 1] ?? "";
  return src.replace(/\s+/g, " ").includes(needle.replace(/\s+/g, " ").slice(0, 15));
}

describe("inspect (read-only inventory)", () => {
  it("finds routes, links them to the business function across files and through an interface", () => {
    const inv = inspect(REFUND);
    expect(inv.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /orders/:id", "POST /refunds", "GET /refunds/:id"]);
    expect(inv.routes.find((r) => r.path === "/refunds")!.handlerCalls).toEqual(["createLegacyRefundService.requestRefund"]);
    const svc = inv.functions.find((f) => f.id === "createLegacyRefundService.requestRefund")!;
    expect(svc.transaction).toBe(true);
    expect(svc.calls).toEqual(expect.arrayContaining(["loadOrder", "decideRefund"]));
    expect(svc.sql.filter((s) => s.op !== "SELECT").map((s) => s.tables[0])).toEqual(["orders", "refunds"]);
    expect(inv.unsupported).toEqual([]); // prepared-statement .get() is not mistaken for a route
  });
  it("detects outbound HTTP effects and reads/writes in a non-refund service", () => {
    const inv = inspect(LOYALTY);
    const f = inv.functions.find((x) => x.id === "RedemptionService.redeem")!;
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]!.detail).toMatch(/^fetch\(/);
    expect(new Set(f.sql.map((s) => s.op))).toEqual(new Set(["SELECT", "UPDATE", "INSERT"]));
    expect(inv.routes.find((r) => r.path === "/redemptions")!.handlerCalls).toEqual(["RedemptionService.redeem"]);
  });
  it("reports constructs it cannot analyse instead of guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mn-an-"));
    writeFileSync(
      join(dir, "bad.ts"),
      `import express from "express";\nconst app = express();\nconst p = "/x" + Math.random();\napp.get(p, (_q, s) => s.end());\nexport function f(db: any, t: string) { return db.prepare("SELECT * FROM " + t).get(); }\nexport function g(code: string) { return eval(code); }\n`,
    );
    const kinds = inspect(dir).unsupported.map((u) => u.construct).sort();
    expect(kinds).toEqual(["computed route path", "dynamic SQL", "eval"]);
  });
});

describe("extract (function-level, with provenance)", () => {
  const m = extract(inspect(REFUND), "requestRefund");
  it("every item is review-required and its source location is real", () => {
    expect(m.items.every((i) => i.review === "required")).toBe(true);
    for (const i of m.items) {
      const needle = i.kind === "read" || i.kind === "effect" ? i.text.split(" ").slice(0, 2).join(" ") : i.text.replace(/^if \(/, "").slice(0, 20);
      expect(provenanceHolds(REFUND, i.source.file, i.source.line, needle), `${i.id} ${i.source.file}:${i.source.line}`).toBe(true);
    }
  });
  it("recovers the policy structure: category-scoped rules, resolved constants, authorization", () => {
    const scoped = (cat: string) => m.items.filter((i) => i.scope === `reason=${cat}`).map((i) => i.candidateRule).filter(Boolean);
    expect(scoped("DAMAGED")).toEqual(["order.ageDays <= 60", "carrier.damaged == true"]);
    expect(scoped("NOT_DELIVERED")).toEqual(["order.ageDays <= 45", "carrier.delivered == false"]);
    expect(scoped("CHANGED_MIND")).toEqual(["order.ageDays <= 30"]);
    expect(m.items.some((i) => i.candidateRule === "order.refundableCents <= 50000")).toBe(true); // MAX_REFUND_CENTS resolved
    expect(m.items.filter((i) => i.kind === "authorization").map((i) => i.candidateRule)).toContain("order.ownerId == user.id");
    expect(m.items.filter((i) => i.kind === "judgment")).toHaveLength(1); // switch on the caller-chosen reason
  });
  it("flags missing tenant filters and computed locals instead of trusting them", () => {
    expect(m.items.filter((i) => i.kind === "read" && i.warnings?.[0]?.includes("tenant"))).toHaveLength(2);
    expect(m.items.find((i) => i.text.includes("d.outcome"))!.confidence).toBe("low");
  });
  it("on a fully deterministic service, finds no model role and says so", () => {
    const l = extract(inspect(LOYALTY), "RedemptionService.redeem");
    expect(l.summary.judgment).toBe(0);
    expect(l.notes[0]).toMatch(/No model-suitable judgment/);
    expect(l.items.filter((i) => i.kind === "effect" && i.warnings?.[0]?.includes("version check")).length).toBe(2);
  });
  it("draft contract carries provenance on every rule and is marked as a draft", () => {
    const d = draftContract(m, "refund.create");
    expect(d.startsWith("# DRAFT")).toBe(true);
    expect(d).toMatch(/- "order\.ageDays <= 60" # m\d+ policy\.ts:\d+/);
    expect(d).toMatch(/OTHER: \{ description: "No establishable reason", alwaysReview: true \}/);
  });
});
