/**
 * Restricted policy expressions.
 *
 * Grammar (one comparison per expression; a list of expressions is a conjunction):
 *
 *   expr     := operand WS op WS operand
 *   op       := "==" | "!=" | "<" | "<=" | ">" | ">="
 *   operand  := path | integer | 'string' | true | false
 *   path     := ident ("." ident)+
 *
 * No function calls, no arithmetic, no member access by computed key, no eval.
 * This is a deliberate deviation from the PRD's CEL suggestion for Phase 0: CEL
 * would be evaluated here only for numeric bounds, and a 60-line parser whose
 * entire surface is visible is easier to audit than a dependency. Revisit when
 * contracts need arithmetic (an early design decision; derived values come from read tools instead).
 */

export type Operand =
  | { kind: "path"; path: string }
  | { kind: "literal"; value: string | number | boolean };

export type Op = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr = {
  source: string;
  left: Operand;
  op: Op;
  right: Operand;
  description?: string;
  /** Application-level reason code when the rule fails. */
  code?: string;
  /** Per-rule handling when a needed fact is not established. */
  unestablished?: { outcome: "review" | "refuse"; code?: string };
};

const PATH = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const INT = /^-?\d+$/;
const STR = /^'([^'\\]*)'$/;
const OPS: Op[] = ["==", "!=", "<=", ">=", "<", ">"];

export class ExprError extends Error {}

function parseOperand(tok: string, source: string): Operand {
  if (tok === "true" || tok === "false") return { kind: "literal", value: tok === "true" };
  if (INT.test(tok)) {
    const n = Number(tok);
    if (!Number.isSafeInteger(n)) throw new ExprError(`integer out of range in "${source}"`);
    return { kind: "literal", value: n };
  }
  const s = STR.exec(tok);
  if (s) return { kind: "literal", value: s[1]! };
  if (PATH.test(tok)) return { kind: "path", path: tok };
  throw new ExprError(`invalid operand "${tok}" in "${source}"`);
}

export function parseExpr(source: string): Expr {
  if (typeof source !== "string" || source.length > 200) throw new ExprError("expression must be a string under 200 chars");
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 3) throw new ExprError(`expected "<operand> <op> <operand>", got "${source}"`);
  const [l, op, r] = parts as [string, string, string];
  if (!OPS.includes(op as Op)) throw new ExprError(`unknown operator "${op}" in "${source}"`);
  return { source, left: parseOperand(l, source), op: op as Op, right: parseOperand(r, source) };
}

export function pathsOf(e: Expr): string[] {
  return [e.left, e.right].flatMap((o) => (o.kind === "path" ? [o.path] : []));
}

/** Result of evaluating one expression against resolved values. */
export type EvalResult =
  | { status: "true" }
  | { status: "false" }
  | { status: "unestablished"; paths: string[] }
  | { status: "type_error"; detail: string };

/**
 * A resolver returns the value for a path, or `undefined` when the value is not
 * established. The gate's resolver returns undefined for anything that is not
 * ESTABLISHING under PSAP, so "unestablished" and "missing" are the same thing.
 */
export type Resolve = (path: string) => { value: unknown } | undefined;

export function evaluate(e: Expr, resolve: Resolve): EvalResult {
  const missing: string[] = [];
  const val = (o: Operand): unknown => {
    if (o.kind === "literal") return o.value;
    const r = resolve(o.path);
    if (r === undefined) {
      missing.push(o.path);
      return undefined;
    }
    return r.value;
  };
  const a = val(e.left);
  const b = val(e.right);
  if (missing.length) return { status: "unestablished", paths: missing };

  if (e.op === "==" || e.op === "!=") {
    const scalar = (x: unknown) => ["string", "number", "boolean"].includes(typeof x);
    if (!scalar(a) || !scalar(b) || typeof a !== typeof b)
      return { status: "type_error", detail: `${e.source}: cannot compare ${typeof a} with ${typeof b}` };
    return (a === b) === (e.op === "==") ? { status: "true" } : { status: "false" };
  }
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b))
    return { status: "type_error", detail: `${e.source}: ordering needs two finite numbers` };
  const ok =
    e.op === "<" ? a < b : e.op === "<=" ? a <= b : e.op === ">" ? a > b : a >= b;
  return ok ? { status: "true" } : { status: "false" };
}
