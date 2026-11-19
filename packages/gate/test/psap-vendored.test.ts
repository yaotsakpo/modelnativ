import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("vendored PSAP resolver", () => {
  it("is byte-identical to PSAP src/authority.ts at the pinned commit", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/psap-authority.ts", import.meta.url)));
    expect(createHash("sha256").update(src).digest("hex")).toBe("944d6040d9a78dec3cd2e96846a574d31d46cca39428a446b005b45038e5693c");
  });
});
