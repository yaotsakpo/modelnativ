import { createHmac, timingSafeEqual } from "node:crypto";
import { SECRET_TOKEN_SIGNING_KEY, type Clock, type SecretStore } from "./ports.ts";

export type Principal = { subject: string; tenant: string; scopes: string[] };

export class AuthError extends Error {
  constructor(readonly code: "malformed_token" | "bad_signature" | "expired") {
    super(code);
  }
}

type Claims = { sub: string; ten: string; scp: string[]; iat: number; exp: number };

const VERSION = "v1";
const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * Compact bearer tokens: `v1.<base64url(claims)>.<base64url(HMAC-SHA256)>`.
 * The signing key is read from the secret store on every use, so it can be rotated.
 */
export class TokenService {
  constructor(
    private readonly secrets: SecretStore,
    private readonly clock: Clock,
  ) {}

  issue(p: Principal & { ttlMs?: number }): string {
    const now = this.clock.now();
    const claims: Claims = { sub: p.subject, ten: p.tenant, scp: p.scopes, iat: now, exp: now + (p.ttlMs ?? DEFAULT_TTL_MS) };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${VERSION}.${body}.${this.sign(body)}`;
  }

  verify(token: string): Principal {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) throw new AuthError("malformed_token");
    const [, body, signature] = parts;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AuthError("bad_signature");

    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AuthError("malformed_token");
    }
    if (typeof claims.sub !== "string" || typeof claims.ten !== "string" || !Array.isArray(claims.scp) || typeof claims.exp !== "number") {
      throw new AuthError("malformed_token");
    }
    if (claims.exp <= this.clock.now()) throw new AuthError("expired");
    return { subject: claims.sub, tenant: claims.ten, scopes: claims.scp };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secrets.get(SECRET_TOKEN_SIGNING_KEY)).update(`${VERSION}.${body}`).digest("base64url");
  }
}
