import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AuditSink } from "./audit.ts";
import { AuthError, type Principal, type TokenService } from "./auth.ts";
import type { RefundResult, RefundService } from "./refund-service.ts";
import { isValidIdempotencyKey, parseRefundRequest } from "./validation.ts";

const REQUIRED_SCOPE = "refund:request";
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

type Locals = { requestId: string; principal: Principal };

const HTTP_STATUS: Record<RefundResult["status"], number> = {
  allowed: 201,
  review: 202,
  refused: 422,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
};

export function createApp(deps: { tokens: TokenService; refunds: RefundService; audit: AuditSink }) {
  const { tokens, refunds, audit } = deps;
  const app = express();
  app.disable("x-powered-by");

  const reject = (res: Response, status: number, error: string, event: string) => {
    const { requestId, principal } = res.locals as Partial<Locals>;
    audit.write({ event, outcome: "refuse", detail: error, requestId, tenant: principal?.tenant, subject: principal?.subject });
    res.status(status).json({ error, requestId });
  };

  const assignRequestId = (req: Request, res: Response, next: NextFunction) => {
    const given = req.header("x-request-id");
    res.locals.requestId = given && REQUEST_ID.test(given) ? given : randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId);
    next();
  };

  // Identity comes only from the bearer token, never from the body.
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) return reject(res, 401, "missing_credentials", "auth.failure");
    try {
      res.locals.principal = tokens.verify(header.slice(7));
    } catch (err) {
      if (err instanceof AuthError) return reject(res, 401, err.code, "auth.failure");
      throw err;
    }
    next();
  };

  const requireScope = (scope: string) => (_req: Request, res: Response, next: NextFunction) => {
    if (!(res.locals as Locals).principal.scopes.includes(scope)) return reject(res, 403, "insufficient_scope", "auth.failure");
    next();
  };

  app.post("/v1/refunds", assignRequestId, authenticate, requireScope(REQUIRED_SCOPE), express.json({ limit: "16kb" }), (req, res) => {
    const { requestId, principal } = res.locals as Locals;
    const idempotencyKey = req.header("idempotency-key");
    if (!isValidIdempotencyKey(idempotencyKey)) return reject(res, 400, "missing_or_invalid_idempotency_key", "request.invalid");
    const parsed = parseRefundRequest(req.body);
    if (!parsed.ok) {
      audit.write({ event: "request.invalid", outcome: "refuse", detail: "invalid_body", requestId, tenant: principal.tenant, subject: principal.subject });
      return res.status(400).json({ error: "invalid_request", details: parsed.errors, requestId });
    }

    const result = refunds.requestRefund({ principal, idempotencyKey, request: parsed.value, requestId });
    const { status, ...rest } = result;
    res.status(HTTP_STATUS[status]).json({ status, ...rest, requestId });
  });

  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return reject(res, 400, "malformed_body", "request.invalid");
    audit.write({ event: "http.error", outcome: "error", requestId: res.locals.requestId });
    res.status(500).json({ error: "internal_error", requestId: res.locals.requestId });
  });

  return app;
}
