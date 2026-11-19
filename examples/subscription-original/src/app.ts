import express, { type NextFunction, type Request, type Response } from "express";
import Ajv, { type JSONSchemaType } from "ajv";
import type { Caller, ChangePlanResponse, RejectionReason, SubscriptionService } from "./service.ts";

export interface PlanChangeBody {
  targetPlanId: string;
  expectedVersion?: number;
}

const planChangeBodySchema: JSONSchemaType<PlanChangeBody> = {
  type: "object",
  properties: {
    targetPlanId: { type: "string", minLength: 1, maxLength: 128 },
    expectedVersion: { type: "integer", minimum: 1, nullable: true },
  },
  required: ["targetPlanId"],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true });
const validatePlanChangeBody = ajv.compile(planChangeBodySchema);

const STATUS_BY_REASON: Record<RejectionReason, number> = {
  not_found: 404,
  forbidden: 403,
  version_conflict: 409,
  subscription_past_due: 422,
  subscription_cancelled: 422,
  plan_not_found: 422,
  plan_not_purchasable: 422,
  same_plan: 422,
  invoice_pending: 422,
  plan_change_limit_reached: 422,
  promo_lock_active: 422,
  seat_limit_exceeded: 422,
};

export function httpStatusFor(result: ChangePlanResponse): number {
  switch (result.status) {
    case "changed":
      return 200;
    case "pending_approval":
      return 202;
    case "rejected":
      return STATUS_BY_REASON[result.reason];
  }
}

export interface AppOptions {
  service: SubscriptionService;
  /** Bearer token -> caller identity. */
  tokens: ReadonlyMap<string, Caller>;
}

type AuthedRequest = Request & { caller?: Caller };

export function createApp({ service, tokens }: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  const authenticate = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const match = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
    const caller = match ? tokens.get(match[1]) : undefined;
    if (!caller) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.caller = caller;
    next();
  };

  app.post("/subscriptions/:id/plan-change", authenticate, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (!validatePlanChangeBody(req.body)) {
        res.status(400).json({ error: "invalid_request", details: validatePlanChangeBody.errors });
        return;
      }
      const result = await service.changePlan(req.caller!, {
        subscriptionId: req.params.id,
        targetPlanId: req.body.targetPlanId,
        expectedVersion: req.body.expectedVersion,
      });
      res.status(httpStatusFor(result)).json(result);
    } catch (err) {
      next(err);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
