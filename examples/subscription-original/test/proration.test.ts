import { describe, expect, it } from "vitest";
import { computeProrationCents } from "../src/proration.ts";

const start = new Date("2026-03-01T00:00:00.000Z");
const end = new Date("2026-03-31T00:00:00.000Z");

describe("computeProrationCents", () => {
  it("charges the price difference for the remaining fraction of the period", () => {
    // 7000 * 20/30 = 4666.67 -> 4667
    expect(computeProrationCents(2_900, 9_900, start, end, new Date("2026-03-11T00:00:00.000Z"))).toBe(4_667);
  });

  it("credits (negative) on a downgrade, rounding the magnitude the same way", () => {
    expect(computeProrationCents(9_900, 2_900, start, end, new Date("2026-03-11T00:00:00.000Z"))).toBe(-4_667);
  });

  it("rounds down below half a cent", () => {
    // 7000 * 10/30 = 2333.33 -> 2333
    expect(computeProrationCents(2_900, 9_900, start, end, new Date("2026-03-21T00:00:00.000Z"))).toBe(2_333);
  });

  it("rounds exact half cents away from zero", () => {
    const s = new Date("2026-01-01T00:00:00.000Z");
    const e = new Date("2026-01-01T00:00:02.000Z");
    const mid = new Date("2026-01-01T00:00:01.000Z");
    expect(computeProrationCents(100, 101, s, e, mid)).toBe(1); // +0.5 -> +1
    expect(computeProrationCents(101, 100, s, e, mid)).toBe(-1); // -0.5 -> -1
    expect(computeProrationCents(100, 103, s, e, mid)).toBe(2); // +1.5 -> +2
    expect(computeProrationCents(103, 100, s, e, mid)).toBe(-2); // -1.5 -> -2
  });

  it("ignores sub-second time (whole seconds only)", () => {
    const at = new Date("2026-03-11T00:00:00.999Z");
    expect(computeProrationCents(2_900, 9_900, start, end, at)).toBe(
      computeProrationCents(2_900, 9_900, start, end, new Date("2026-03-11T00:00:00.000Z")),
    );
  });

  it("charges the full difference at period start and nothing at or after period end", () => {
    expect(computeProrationCents(2_900, 9_900, start, end, start)).toBe(7_000);
    expect(computeProrationCents(2_900, 9_900, start, end, new Date("2026-02-15T00:00:00.000Z"))).toBe(7_000);
    expect(computeProrationCents(2_900, 9_900, start, end, end)).toBe(0);
    expect(computeProrationCents(2_900, 9_900, start, end, new Date("2026-04-15T00:00:00.000Z"))).toBe(0);
  });

  it("returns 0 for a degenerate period", () => {
    expect(computeProrationCents(2_900, 9_900, end, start, start)).toBe(0);
  });

  it("stays exact for large amounts over long periods", () => {
    const s = new Date("2026-01-01T00:00:00.000Z");
    const e = new Date("2027-01-01T00:00:00.000Z");
    const half = new Date("2026-07-02T12:00:00.000Z");
    // 1e10 cents * exactly half of a 365-day year = 5e9
    expect(computeProrationCents(0, 10_000_000_000, s, e, half)).toBe(5_000_000_000);
  });
});
