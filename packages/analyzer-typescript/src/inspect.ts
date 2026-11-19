/**
 * Read-only static inventory of a TypeScript backend (PRD §10 Discover, §21.8).
 *
 * Uses the TypeScript compiler API (with the type checker for parameter types). Finds:
 * HTTP routes (Express-style), functions and methods, the SQL each one reads and writes,
 * external effects, auth checks, transactions, decision points (if-with-return/throw,
 * switch), and intra-project calls. Anything it cannot analyse statically is reported as
 * unsupported, never guessed. Every finding carries file + line provenance.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type Loc = { file: string; line: number; endLine: number };
export type SqlUse = Loc & {
  op: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "OTHER";
  tables: string[];
  text: string;
  /** SELECT list (null for "*" or computed). */
  columns: string[] | null;
  /** The local variable the read lands in, if any (e.g. "acct"). */
  assignedTo?: string;
  /** Source text of the bound arguments of .get/.run/.all. */
  boundArgs: string[];
};
export type JsonSchema = Record<string, unknown>;
export type ReturnInfo = Loc & { text: string; fields: Record<string, string> };
export type Decision =
  | (Loc & { kind: "if"; condition: string; outcome: string; /** enclosing switch case, e.g. "reason=DAMAGED" */ scope?: string })
  | (Loc & { kind: "switch"; discriminant: string; cases: string[] });

export type FunctionInfo = Loc & {
  id: string; // "Class.method", "container.method" or "name"
  name: string;
  exported: boolean;
  params: { name: string; type: string; schema: JsonSchema; schemaNotes: string[] }[];
  /** Every return statement (object literals parsed into string fields). */
  returnsAt: ReturnInfo[];
  returns: string;
  sql: SqlUse[];
  effects: (Loc & { kind: "http" | "other"; detail: string })[];
  auth: (Loc & { detail: string })[];
  transaction: boolean;
  decisions: Decision[];
  calls: string[]; // ids of project functions called
  /** Local variables assigned from a SQL read (their fields are stored facts). */
  dbLocals: string[];
};

export type RouteInfo = Loc & { method: string; path: string; handlerCalls: string[] };
export type Unsupported = Loc & { construct: string; why: string };

export type Inventory = {
  root: string;
  files: string[];
  /** Module-level numeric/string constants, for resolving names in rules. */
  constants: Record<string, string>;
  routes: RouteInfo[];
  functions: FunctionInfo[];
  unsupported: Unsupported[];
};

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".") || e === "testing" || e === "test" || e === "tests") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec|d)\.ts$/.test(e)) out.push(p);
  }
  return out.sort();
}

/** TypeScript type -> JSON Schema, conservatively. Anything uncertain is noted for review. */
function toSchema(t: ts.Type, notes: string[], depth: number): JsonSchema {
  if (depth > 3) return (notes.push("type nested too deeply"), {});
  const f = t.flags;
  if (f & ts.TypeFlags.StringLiteral) return { const: (t as ts.StringLiteralType).value };
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
    if (parts.every((x) => x.flags & ts.TypeFlags.StringLiteral)) return { type: "string", enum: parts.map((x) => (x as ts.StringLiteralType).value) };
    if (parts.length === 1) return toSchema(parts[0]!, notes, depth + 1);
    return { anyOf: parts.map((x) => toSchema(x, notes, depth + 1)) };
  }
  if (f & ts.TypeFlags.String) return { type: "string" };
  if (f & ts.TypeFlags.Number) return (notes.push("number: integer or not? (money and counts are usually integers)"), { type: "number" });
  if (f & ts.TypeFlags.Boolean || f & ts.TypeFlags.BooleanLiteral) return { type: "boolean" };
  if (f & ts.TypeFlags.Object) {
    const props = t.getProperties();
    const checker = (t as unknown as { checker: ts.TypeChecker }).checker;
    if (!checker || props.some((p) => p.valueDeclaration && ts.isMethodSignature(p.valueDeclaration))) return (notes.push(`object type with methods: ${props.length} members`), {});
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      if (!decl) continue;
      properties[p.name] = toSchema(checker.getTypeOfSymbolAtLocation(p, decl), notes, depth + 1);
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    return { type: "object", additionalProperties: false, required, properties };
  }
  notes.push(`unsupported type ${f}`);
  return {};
}

function sqlOf(text: string): { op: SqlUse["op"]; tables: string[] } {
  const t = text.replace(/\s+/g, " ").trim();
  const op = (/^(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(t)?.[1]?.toUpperCase() ?? "OTHER") as SqlUse["op"];
  const tables = new Set<string>();
  for (const re of [/\bFROM\s+([A-Za-z_][\w]*)/gi, /\bJOIN\s+([A-Za-z_][\w]*)/gi, /\bINTO\s+([A-Za-z_][\w]*)/gi, /^UPDATE\s+([A-Za-z_][\w]*)/gi])
    for (const m of t.matchAll(re)) tables.add(m[1]!);
  return { op, tables: [...tables] };
}

export function inspect(root: string): Inventory {
  const files = listTs(root);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const rel = (f: string) => relative(root, f);
  const loc = (n: ts.Node): Loc => {
    const sf = n.getSourceFile();
    return { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, endLine: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 };
  };
  const text = (n: ts.Node) => n.getText().replace(/\s+/g, " ");

  const inv: Inventory = { root, files: files.map(rel), constants: {}, routes: [], functions: [], unsupported: [] };
  const fnByDecl = new Map<ts.Node, FunctionInfo>();

  // ---- pass 1: functions and methods
  /** An Express-style route registration: <app|router>.<method>("/literal", ..., handler). */
  const routeCall = (n: ts.Node): { method: string; path: string } | null => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
    const m = n.expression.name.text;
    if (!ROUTE_METHODS.has(m) || n.arguments.length < 2) return null;
    const recvType = checker.typeToString(checker.getTypeAtLocation(n.expression.expression));
    const typed = /Express|Router|Application/.test(recvType);
    // Unresolved types (no node_modules): fall back to conventional receiver names.
    const untypedButNamed = /^(any|error)$/.test(recvType) && /^(app|router|api|server)$/.test(n.expression.expression.getText());
    if (!typed && !untypedButNamed) return null; // e.g. a prepared statement's .get()
    const p = n.arguments[0]!;
    return { method: m.toUpperCase(), path: ts.isStringLiteral(p) ? p.text : "<computed>" };
  };

  const idOf = (n: ts.Node): { id: string; name: string } | null => {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isCallExpression(n.parent)) {
      const r = routeCall(n.parent);
      if (r && n.parent.arguments[n.parent.arguments.length - 1] === n) return { id: `route:${r.method} ${r.path}`, name: `${r.method} ${r.path}` };
    }
    if (ts.isFunctionDeclaration(n) && n.name) return { id: n.name.text, name: n.name.text };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) {
      const owner = n.parent;
      if (ts.isClassDeclaration(owner) && owner.name) return { id: `${owner.name.text}.${n.name.text}`, name: n.name.text };
      if (ts.isObjectLiteralExpression(owner)) {
        let c: ts.Node | undefined = owner.parent;
        while (c && !ts.isFunctionDeclaration(c)) c = c.parent;
        const container = c && ts.isFunctionDeclaration(c) && c.name ? c.name.text : "object";
        return { id: `${container}.${n.name.text}`, name: n.name.text };
      }
    }
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name))
      return { id: n.parent.name.text, name: n.parent.name.text };
    return null;
  };

  for (const sf of program.getSourceFiles()) {
    if (!files.includes(sf.fileName)) continue;
    const visit = (n: ts.Node) => {
      const ident = idOf(n);
      if (ident && (n as ts.FunctionLikeDeclaration).body) {
        const fn = n as ts.FunctionLikeDeclaration;
        const sig = checker.getSignatureFromDeclaration(fn);
        const exported = !!(ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Export) || ts.isMethodDeclaration(fn);
        const info: FunctionInfo = {
          ...loc(fn),
          ...ident,
          exported,
          params: fn.parameters.map((p) => {
            const t = checker.getTypeAtLocation(p);
            const notes: string[] = [];
            return { name: p.name.getText(), type: checker.typeToString(t), schema: toSchema(t, notes, 0), schemaNotes: notes };
          }),
          returnsAt: [],
          returns: sig ? checker.typeToString(sig.getReturnType()) : "unknown",
          sql: [],
          effects: [],
          auth: [],
          transaction: false,
          decisions: [],
          calls: [],
          dbLocals: [],
        };
        inv.functions.push(info);
        fnByDecl.set(fn, info);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const enclosingFn = (n: ts.Node): FunctionInfo | undefined => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
      const f = fnByDecl.get(c);
      if (f) return f;
    }
    return undefined;
  };
  const returnsOrThrows = (s: ts.Statement): string | null => {
    if (ts.isReturnStatement(s)) return s.expression ? text(s.expression).slice(0, 120) : "return";
    if (ts.isThrowStatement(s)) return `throw ${text(s.expression).slice(0, 100)}`;
    if (ts.isBlock(s)) for (const x of s.statements) {
      const r = returnsOrThrows(x);
      if (r) return r;
    }
    return null;
  };

  // ---- pass 2: facts inside functions, routes, unsupported constructs
  for (const sf of program.getSourceFiles()) {
    if (!files.includes(sf.fileName)) continue;
    const visit = (n: ts.Node) => {
      const fn = enclosingFn(n);
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        // SQL through prepare("...")
        if (name === "prepare" && n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))) {
          const t = (n.arguments[0] as ts.StringLiteral).text;
          // prepare(...).get(args) / .run(args) / .all(args), possibly assigned to a local
          const outer = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.parent && ts.isCallExpression(n.parent.parent) ? n.parent.parent : undefined;
          let assignedTo: string | undefined;
          for (let c: ts.Node | undefined = outer ?? n; c && !ts.isBlock(c); c = c.parent)
            if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name)) {
              assignedTo = c.name.text;
              break;
            }
          const sel = /^\s*SELECT\s+(.+?)\s+FROM\s/is.exec(t);
          const columns = sel && sel[1]!.trim() !== "*" ? sel[1]!.split(",").map((x) => x.trim().split(/\s+AS\s+/i).pop()!.trim()) : null;
          fn?.sql.push({ ...loc(n), ...sqlOf(t), text: t.replace(/\s+/g, " ").trim().slice(0, 160), columns, ...(assignedTo ? { assignedTo } : {}), boundArgs: outer ? outer.arguments.map((a) => text(a)) : [] });
        } else if (name === "prepare" && n.arguments[0]) {
          inv.unsupported.push({ ...loc(n), construct: "dynamic SQL", why: "SQL text is not a literal; tables and operation cannot be determined statically" });
        }
        if (name === "transaction" && fn) fn.transaction = true;
        if (name === "fetch" || (ts.isPropertyAccessExpression(callee) && /^(axios|got|request|http|https)$/.test(callee.expression.getText()))) fn?.effects.push({ ...loc(n), kind: "http", detail: text(n).slice(0, 120) });
        if (/^(auth|authenticate|verify|requireAuth)$/.test(name)) fn?.auth.push({ ...loc(n), detail: text(n).slice(0, 100) });
        if (name === "eval" || (ts.isIdentifier(callee) && callee.text === "require" && n.arguments[0] && !ts.isStringLiteral(n.arguments[0])))
          inv.unsupported.push({ ...loc(n), construct: name, why: "dynamic code loading cannot be analysed" });
        // Routes: <app|router>.post("/path", ..., handler)
        const rc = routeCall(n);
        if (rc) {
          if (rc.path === "<computed>") inv.unsupported.push({ ...loc(n), construct: "computed route path", why: "the route path is not a literal" });
          else {
            const handler = n.arguments[n.arguments.length - 1]!;
            const h = fnByDecl.get(handler);
            inv.routes.push({ ...loc(n), method: rc.method, path: rc.path, handlerCalls: h ? h.calls : [] });
          }
        }
        // Intra-project calls
        const target = resolveCall(n);
        if (fn && target && target !== fn.id && !fn.calls.includes(target)) fn.calls.push(target);
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Function")
        inv.unsupported.push({ ...loc(n), construct: "new Function", why: "dynamic code cannot be analysed" });
      if (fn && ts.isIfStatement(n)) {
        const out = returnsOrThrows(n.thenStatement);
        if (out) {
          // Record the enclosing switch case, so a rule inside `case "X":` stays attached to X.
          let scope: string | undefined;
          for (let c: ts.Node | undefined = n.parent; c && c !== (fn as unknown as ts.Node); c = c.parent)
            if (ts.isCaseClause(c) && ts.isSwitchStatement(c.parent.parent)) {
              scope = `${text(c.parent.parent.expression)}=${text(c.expression).replace(/["']/g, "")}`;
              break;
            }
          fn.decisions.push({ ...loc(n), kind: "if", condition: text(n.expression), outcome: out, ...(scope ? { scope } : {}) });
        }
      }
      // Locals assigned from a SQL read: `const acct = db.prepare("SELECT ...").get(...)`
      if (fn && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\.prepare\(\s*["'`]\s*SELECT/i.test(n.initializer.getText())) fn.dbLocals.push(n.name.text);
      if (fn && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /^loadOrder|^load|^find|^get/.test(n.initializer.getText().replace(/^await\s+/, ""))) fn.dbLocals.push(n.name.text);
      // Module-level constants: const NAME = 123 / "x"
      if (!fn && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isNumericLiteral(n.initializer) || ts.isStringLiteral(n.initializer)))
        inv.constants[n.name.text] = ts.isNumericLiteral(n.initializer) ? n.initializer.text.replace(/_/g, "") : `'${n.initializer.text}'`;
      if (fn && ts.isReturnStatement(n) && n.expression) {
        const fields: Record<string, string> = {};
        const lit = ts.isObjectLiteralExpression(n.expression) ? n.expression : undefined;
        for (const p of lit?.properties ?? [])
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) fields[p.name.text] = ts.isStringLiteral(p.initializer) ? p.initializer.text : `<${text(p.initializer).slice(0, 40)}>`;
        fn.returnsAt.push({ ...loc(n), text: text(n.expression).slice(0, 120), fields });
      }
      if (fn && ts.isSwitchStatement(n))
        fn.decisions.push({
          ...loc(n),
          kind: "switch",
          discriminant: text(n.expression),
          cases: n.caseBlock.clauses.map((c) => (ts.isCaseClause(c) ? text(c.expression) : "default")),
        });
      if (fn && ts.isPropertyAccessExpression(n) && /authorization/i.test(n.getText()) === false && ts.isCallExpression(n.parent) && /header/.test(n.name.text)) {
        const arg = (n.parent as ts.CallExpression).arguments[0];
        if (arg && ts.isStringLiteral(arg) && /authorization/i.test(arg.text)) fn.auth.push({ ...loc(n.parent), detail: "reads Authorization header" });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  function resolveCall(n: ts.CallExpression): string | null {
    let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym); // follow imports
    const decl = sym?.declarations?.[0];
    if (!decl) return null;
    const target = fnByDecl.get(decl) ?? (ts.isVariableDeclaration(decl) && decl.initializer ? fnByDecl.get(decl.initializer) : undefined);
    if (target) return target.id;
    // A call through an interface method: link to the project implementation(s) of that name.
    if (ts.isMethodSignature(decl) && ts.isIdentifier(decl.name)) {
      const impls = inv.functions.filter((f) => f.name === (decl.name as ts.Identifier).text && !f.id.startsWith("route:"));
      if (impls.length === 1) return impls[0]!.id;
      if (impls.length > 1) return `interface:${decl.parent && ts.isInterfaceDeclaration(decl.parent) ? decl.parent.name.text : "?"}.${(decl.name as ts.Identifier).text}`;
    }
    return null;
  }

  return inv;
}
