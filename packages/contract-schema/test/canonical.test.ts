/**
 * canonicalJson: pinned behaviour. Hashes (contract hash, idempotency request hash,
 * model-input hash, replay comparisons) depend on it, so ANY change to an output
 * below is a hash migration and needs docs/canonical-json.md's migration procedure.
 *
 * Supported input domain (the guarantee): JSON values. null, booleans, finite
 * numbers, strings without lone surrogates, arrays without holes, plain objects
 * whose values are themselves in the domain. Within it, output equals RFC 8785 (JCS).
 * Outside it, behaviour is PINNED here but is not a guarantee; see the doc.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/index.ts";

describe("canonicalJson: RFC 8785 vectors (in domain)", () => {
  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    // Compare positions in the TEXT: parsing it back would reorder keys (JS lists integer-like keys first).
    const text = canonicalJson(input);
    const order = ["\\r", '"1"', "\u0080", "ö", "€", "😀", "דּ"].map((k) => text.indexOf(k));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("serialises the RFC 8785 §3.2.2 sample exactly", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("serialises numbers as ECMAScript does (RFC 8785 Appendix B sample)", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [5e-324, "5e-324"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
      [9007199254740992, "9007199254740992"],
      [295147905179352830000, "295147905179352830000"],
      [1e21, "1e+21"],
      [0.000001, "0.000001"],
      [1e-7, "1e-7"],
      [-1.5, "-1.5"],
    ];
    for (const [n, s] of cases) expect(canonicalJson(n), String(n)).toBe(s);
  });

  it("is independent of key insertion order and stable under a JSON round trip", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const once = canonicalJson(v);
        expect(canonicalJson(JSON.parse(JSON.stringify(v)))).toBe(once);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
        expect(JSON.parse(once)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
      { numRuns: 2000, seed: 8785 },
    );
    const a = { b: 1, a: [{ y: 2, x: 1 }] };
    const b = { a: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("canonicalJson: pinned behaviour OUTSIDE the domain (not a guarantee; see docs/canonical-json.md)", () => {
  it("undefined", () => {
    expect(canonicalJson(undefined)).toBeUndefined();
    expect(canonicalJson({ a: undefined })).toBe('{"a":undefined}'); // NOT valid JSON; JSON.stringify would drop the key
    // Array.join renders undefined as "": [undefined] COLLIDES with [] (JSON.stringify gives [null]).
    expect(canonicalJson([undefined])).toBe("[]");
    expect(canonicalJson([undefined])).toBe(canonicalJson([]));
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([1, , 3])).toBe("[1,,3]"); // invalid JSON
  });
  it("non-finite numbers collapse to null (JCS requires an error)", () => {
    expect(canonicalJson(NaN)).toBe("null");
    expect(canonicalJson(Infinity)).toBe("null");
  });
  it("non-plain objects lose their content", () => {
    expect(canonicalJson(new Date(0))).toBe("{}"); // JSON.stringify gives the ISO string (toJSON)
    expect(canonicalJson(new Map([["a", 1]]))).toBe("{}");
    expect(canonicalJson({ toJSON: () => "x" })).toBe('{"toJSON":undefined}');
  });
  it("lone surrogates are escaped (JCS input must be I-JSON, which forbids them)", () => {
    expect(canonicalJson("\ud800")).toBe('"\\ud800"');
  });
  it("BigInt and cycles throw", () => {
    expect(() => canonicalJson(1n)).toThrow();
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrow();
  });
});
