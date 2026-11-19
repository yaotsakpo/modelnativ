import express from "express";
import type { Engine, OperationResult } from "./engine.ts";
import type { Identity } from "./identity.ts";

/**
 * An unexpected exception (a bug, a crashed dependency) answers 500 with no internal detail.
 * Express 4 does not catch rejected async handlers: without this the request would hang and the
 * unhandled rejection would terminate the process (Node's default).
 */
const guard =
  (onError: (e: unknown) => void, fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      try {
        onError(e);
      } catch {
        /* ignore */
      }
      if (!res.headersSent) res.status(500).json({ outcome: "ERROR", code: "INTERNAL_ERROR" });
    });

/** 5xx answers describe infrastructure: their internal detail (e.g. database errors) stays in audit/trace. */
const publicBody = (r: OperationResult) => {
  if (r.httpStatus < 500) return r;
  const { detail: _internal, ...rest } = r;
  return rest;
};

/** Mounts each engine at POST /v1/<operation>. Identity comes from the Authorization header only. */
export function createServer(engines: Engine[], identity: Identity, opts: { onError?: (e: unknown) => void } = {}) {
  const onError = opts.onError ?? ((e: unknown) => console.error("modelnativ: unhandled error", e));
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  for (const engine of engines) {
    app.post(`/v1/${engine.contract.name}`, guard(onError, async (req, res) => {
      const auth = req.header("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const principal = identity.verify(token);
      const r = await engine.handle({ principal, body: req.body, idempotencyKey: req.header("idempotency-key") ?? null });
      if (r.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      res.status(r.httpStatus).json(publicBody(r));
    }));
    app.post(`/v1/${engine.contract.name}/resume`, guard(onError, async (req, res) => {
      const auth = req.header("authorization");
      const principal = identity.verify(auth?.startsWith("Bearer ") ? auth.slice(7) : null);
      const r = await engine.resume({ principal, token: req.body?.token, answer: req.body?.answer ?? {} });
      if (r.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      res.status(r.httpStatus).json(publicBody(r));
    }));
  }
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
