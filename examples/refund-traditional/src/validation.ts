import Ajv, { type JSONSchemaType } from "ajv";
import type { Reason } from "./policy.ts";

export type RefundRequest = {
  orderId: string;
  reason: Reason;
  message: string;
  amountCents?: number;
  claims?: { damaged?: boolean; delivered?: boolean };
};

const refundRequestSchema: JSONSchemaType<RefundRequest> = {
  type: "object",
  additionalProperties: false,
  required: ["orderId", "reason", "message"],
  properties: {
    orderId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
    reason: { type: "string", enum: ["DAMAGED", "NOT_DELIVERED", "CHANGED_MIND", "OTHER"] },
    message: { type: "string", maxLength: 2000 },
    amountCents: { type: "integer", nullable: true },
    claims: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: [],
      properties: {
        damaged: { type: "boolean", nullable: true },
        delivered: { type: "boolean", nullable: true },
      },
    },
  },
};

const ajv = new Ajv({ strict: true, allErrors: true });
const validateRefundRequest = ajv.compile(refundRequestSchema);

export type ValidationResult = { ok: true; value: RefundRequest } | { ok: false; errors: { path: string; message: string }[] };

export function parseRefundRequest(input: unknown): ValidationResult {
  if (validateRefundRequest(input)) return { ok: true, value: input };
  const errors = (validateRefundRequest.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
  return { ok: false, errors };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return key !== undefined && IDEMPOTENCY_KEY.test(key);
}
