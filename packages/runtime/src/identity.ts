/**
 * Ingress identity (§21.3, Phase 0 subset): a short-lived, HMAC-signed principal
 * context. The signing key comes from the SecretStore; nothing in a request body
 * can set principal, tenant or scopes. OIDC/OAuth2 adapters plug in here later:
 * they verify the external token and mint this same context.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal } from "@modelnativ/contract-schema";
import type { SecretStore } from "@modelnativ/effect-executor";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export class Identity {
  constructor(private secrets: SecretStore, private now: () => number, private keyName = "ingress.signingKey") {}

  issue(p: Omit<Principal, "expiresAt">, ttlMs = 15 * 60_000): string {
    const payload = b64(JSON.stringify({ ...p, expiresAt: this.now() + ttlMs }));
    return `mn1.${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined | null): Principal | null {
    if (!token || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "mn1") return null;
    const [, payload, sig] = parts as [string, string, string];
    const expect = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
    let p: Principal;
    try {
      p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof p.subject !== "string" || typeof p.tenant !== "string" || !Array.isArray(p.scopes)) return null;
    if (typeof p.expiresAt !== "number" || p.expiresAt <= this.now()) return null;
    return p;
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secrets.get(this.keyName)).update(payload).digest("base64url");
  }
}
