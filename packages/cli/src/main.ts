#!/usr/bin/env node
/**
 * modelnativ CLI (Phase 0 subset).
 *
 * Exit codes (stable): 0 ok | 1 failure (tests failed, divergence, contract rejected)
 *                      2 usage error | 3 environment error (missing weights, digest mismatch)
 * Every command accepts --json for machine-readable output on stdout.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ContractError, loadContract } from "@modelnativ/contract-compiler";

const VERSION = "0.0.1";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !["--json", "--dry-run", "--cpu", "--replay", "--concurrency", "--faults", "--expanded", "--explain", "--detail", "--dev", "--force", "--setup"].includes(argv[i - 1]!)));

function out(data: unknown, text: string, code = 0): never {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write(text + "\n");
  process.exit(code);
}
function fail(code: number, error: string, details: unknown = {}): never {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error, ...((details as object) ?? {}) }, null, 2) + "\n");
  else {
    process.stderr.write(`error: ${error}\n`);
    for (const p of (details as { problems?: string[] }).problems ?? []) process.stderr.write(`  - ${p}\n`);
  }
  process.exit(code);
}

const HELP = `modelnativ ${VERSION}

Usage: modelnativ <command> [options]

Commands:
  compile <contract.yaml> [--expanded] [--explain]
  review <operation> [--app DIR] [--detail]
                                   One-page review of an operation: rules, reads, derived values,
                                   writes, sends, idempotency, failures, evidence, what is unverified
  lint [appDir]                       heuristic: constants duplicated between contract rules and adapter code
                                   Validate and compile a contract; print its hash, or the
                                   fully explicit form (every default written out)
  serve [appDir] [--port N] [--dev] [--model none|<manifest id>] [--db FILE] [--setup]
                                   Requires MN_SECRET_INGRESS_SIGNINGKEY, or --dev (ephemeral key, demo token)
                                   Serve every contract of the app in appDir (modelnativ.config.ts)
  test [--replay|--concurrency|--faults]
                                   Run the deterministic suites (no live model)
  replay <trace-id> [--app DIR] [--traces DIR]
                                   Re-run a recorded operation from its trace; diff it
  bench [--model ID] [--runs N]    Live-model evaluation (reported separately from tests)
  model pull <id>                  Download pinned weights and verify their sha256
  model list                       Show pinned models

Global: --json  --help  --version  --dry-run (for commands that write files)

  inspect [srcDir]                 Read-only inventory: routes, functions, SQL, effects, unsupported constructs
  extract [srcDir] --function <id> --name <op> [--decision auto|fixed|field|hybrid]
          [--message-field f] [--out DIR] [--dry-run] [--force]
                                   Candidate contract + adapter scaffold + migration report (never trusted)

Not yet: migrate (integration codegen), verify (CLI over the differential harness), shadow report.`;

async function main() {
  if (flag("version")) out({ version: VERSION }, VERSION);
  const [cmd, sub] = positional;
  if (!cmd || flag("help")) out({ help: HELP }, HELP);

  switch (cmd) {
    case "compile": {
      const file = sub;
      if (!file) fail(2, "compile needs a contract path");
      try {
        const c = loadContract(resolve(file), { readTools: undefined, effectTools: undefined });
        if (flag("explain")) {
          const { explainShorthand } = await import("@modelnativ/contract-compiler");
          const notes = explainShorthand((await import("yaml")).default.parse(readFileSync(resolve(file), "utf8")));
          out({ explain: notes }, notes.length ? notes.join("\n") : "(explicit contract: nothing is defaulted or expanded)");
        }
        if (flag("expanded")) {
          const { expandContract } = await import("@modelnativ/contract-compiler");
          const x = expandContract(c);
          out(x, (await import("yaml")).default.stringify(x));
        }
        out(
          { ok: true, name: c.name, version: c.version, hash: c.hash, facts: [...c.predicates].sort(), categories: Object.keys(c.categories), effects: Object.keys(c.effects) },
          `ok  ${c.name}@${c.version}  sha256:${c.hash}`,
        );
      } catch (e) {
        if (e instanceof ContractError) fail(1, "contract rejected", { problems: e.problems });
        fail(1, (e as Error).message);
      }
    }
    case "review": {
      const op = sub;
      if (!op) fail(2, "review needs an operation name (and --app DIR, default: current directory)");
      const { reviewApp } = await import("./review-app.ts");
      const review = await reviewApp(resolve(opt("app") ?? process.cwd()), op!).catch((e: Error) => fail(1, e.message));
      out(review.json, flag("detail") ? `${review.text}\n\n${review.detail}` : review.text);
      break;
    }
    case "lint": {
      // Heuristic checks over an app directory (contracts + adapter code). Exit 1 when something is found.
      const dir = resolve(sub ?? process.cwd());
      const { findDuplicatedConstants, idempotencyRecommendations } = await import("@modelnativ/analyzer-typescript");
      const dups = findDuplicatedConstants(dir);
      const recs = idempotencyRecommendations(dir);
      if (!json && recs.length)
        process.stdout.write(`recommendation (advisory): declare spec.idempotency.settle (recommended for new operations: terminal); existing behaviour is unchanged until you opt in:\n${recs.map((r) => `  ${r.operation}  ${r.file}`).join("\n")}\n`);
      out(
        { duplicatedConstants: dups, idempotencyRecommendations: recs },
        dups.length
          ? [`duplicated business constants (${dups.length}): the same number decides in a contract rule and in code; make it one established fact (e.g. policy.*) passed to the adapter`, ...dups.map((d) => `  ${d.value}: ${d.rule.file} ${d.rule.path} "${d.rule.expr}"  <->  ${d.code.file}:${d.code.line}  ${d.code.text}`)].join("\n")
          : "no duplicated business constants found",
      );
      if (dups.length) process.exit(1);
      break;
    }
    case "inspect": {
      const dir = resolve(sub ?? process.cwd());
      const { inspect } = await import("@modelnativ/analyzer-typescript");
      const inv = inspect(dir);
      out(
        inv,
        [
          `routes (${inv.routes.length}):`,
          ...inv.routes.map((r) => `  ${r.method} ${r.path}  -> ${r.handlerCalls.join(", ") || "(inline)"}  ${r.file}:${r.line}`),
          `functions (${inv.functions.filter((f) => !f.id.startsWith("route:")).length}):`,
          ...inv.functions.filter((f) => !f.id.startsWith("route:")).map((f) => `  ${f.id}  ${f.file}:${f.line}  sql:${f.sql.map((q) => `${q.op}(${q.tables})`).join(" ") || "-"}  effects:${f.effects.length}  tx:${f.transaction}  decisions:${f.decisions.length}`),
          `unsupported (${inv.unsupported.length}):`,
          ...inv.unsupported.map((u) => `  ${u.file}:${u.line} ${u.construct}: ${u.why}`),
        ].join("\n"),
      );
    }
    case "extract": {
      const dir = resolve(sub ?? process.cwd());
      const fn = opt("function");
      const name = opt("name");
      if (!fn || !name) fail(2, "extract needs --function <id> and --name <operation.name>");
      const { inspect, generateMigration } = await import("@modelnativ/analyzer-typescript");
      const g = generateMigration(inspect(dir), fn, { name, decision: (opt("decision") ?? "auto") as never, messageField: opt("message-field") });
      const outDir = resolve(opt("out") ?? join(dir, "..", "modelnativ", "generated"));
      const files = { [`${name}.contract.draft.yaml`]: g.contractYaml, "adapters.scaffold.ts.txt": g.adaptersTs, "migration-report.md": g.reportMd, "manifest.json": JSON.stringify(g.manifest, null, 2) };
      if (!flag("dry-run")) {
        const { mkdirSync, writeFileSync, existsSync: ex } = await import("node:fs");
        mkdirSync(outDir, { recursive: true });
        for (const [f, body] of Object.entries(files)) {
          if (ex(join(outDir, f)) && !flag("force")) fail(1, `${join(outDir, f)} exists; pass --force to overwrite generated files`);
          writeFileSync(join(outDir, f), body);
        }
      }
      out(
        { ok: true, dryRun: flag("dry-run"), outDir, files: Object.keys(files), summary: g.manifest.summary, manualItems: g.manifest.manualItems },
        `${flag("dry-run") ? "would write" : "wrote"} ${Object.keys(files).length} files to ${outDir}\n${g.manifest.manualItems.length} manual items:\n${g.manifest.manualItems.map((x) => `  - ${x}`).join("\n")}`,
      );
    }
    case "test": {
      const target = flag("replay") ? "tests/replay" : flag("concurrency") ? "tests/concurrency" : flag("faults") ? "tests/integration/state.test.ts" : "";
      const args = ["vitest", "run", ...(target ? [target] : []), ...(json ? ["--reporter=json"] : [])];
      // a named suite may be in the slow set (vitest.config.ts): select all suites so it is found
      const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...(target ? { MN_TEST: "all" } : {}) } });
      process.exit(r.status === 0 ? 0 : 1);
    }
    case "bench": {
      if (!existsSync(join(ROOT, "bench", "run.ts"))) fail(2, "the live-model evaluation harness (bench/run.ts) is not part of this distribution");
      const r = spawnSync("npx", ["tsx", "bench/run.ts", ...argv.filter((a) => a !== "bench")], { cwd: ROOT, stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    case "replay": {
      const id = sub;
      if (!id) fail(2, "replay needs a trace id");
      const { DirTraces } = await import("@modelnativ/observability");
      const { replayTrace, loadAppConfig } = await import("@modelnativ/runtime");
      const traces = new DirTraces(resolve(opt("traces") ?? join(process.cwd(), ".modelnativ", "traces")));
      const t = traces.get(id);
      if (!t) fail(1, `trace not found: ${id}`);
      // Any app: compile its contracts, pick the one the trace was recorded against.
      const { config, dir } = await loadAppConfig(resolve(opt("app") ?? process.cwd()));
      const contracts = config.contracts.map((c) => loadContract(resolve(dir, c)));
      const contract = contracts.find((c) => c.hash === t.contractHash);
      if (!contract) fail(1, `no contract in this app matches the trace's contract hash ${t.contractHash.slice(0, 12)}`);
      try {
        const tools = contract.source.spec.facts.filter((f) => f.tool !== "request").map((f) => f.tool);
        const r = await replayTrace(t, contract, tools);
        out({ ok: r.identical, traceId: id, outcome: r.result.outcome, code: r.result.code ?? null, diffs: r.diffs }, `${r.identical ? "identical" : "DIVERGED"}  ${id}  ${r.result.outcome}${r.result.code ? ":" + r.result.code : ""}${r.diffs.length ? "  diffs: " + r.diffs.join(",") : ""}`, r.identical ? 0 : 1);
      } catch (e) {
        fail(1, `replay diverged: ${(e as Error).message}`);
      }
    }
    case "model": {
      const manifest = JSON.parse(readFileSync(join(ROOT, "models", "manifest.json"), "utf8")) as Record<string, { url: string; file: string; sha256: string; license: string }>;
      if (sub === "list") out(manifest, Object.entries(manifest).map(([k, m]) => `${k}  ${m.license}  ${existsSync(join(ROOT, "models", m.file)) ? "installed" : "not installed"}`).join("\n"));
      if (sub !== "pull") fail(2, "usage: model pull <id> | model list");
      const id = positional[2];
      const m = id ? manifest[id] : undefined;
      if (!m) fail(2, `unknown model id; known: ${Object.keys(manifest).join(", ")}`);
      const dest = join(ROOT, "models", m.file);
      if (flag("dry-run")) out({ ok: true, dryRun: true, url: m.url, dest }, `would download ${m.url} -> ${dest}`);
      if (!existsSync(dest)) {
        const res = await fetch(m.url);
        if (!res.ok || !res.body) fail(3, `download failed: HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${dest}.part`));
        renameSync(`${dest}.part`, dest);
      }
      const h = createHash("sha256");
      for await (const chunk of createReadStream(dest)) h.update(chunk as Buffer);
      const got = h.digest("hex");
      if (got !== m.sha256) fail(3, "digest mismatch", { expected: m.sha256, got });
      out({ ok: true, id, path: dest, sha256: got }, `ok  ${id}  sha256:${got}`);
    }
    case "serve": {
      const appDir = resolve(sub ?? process.cwd());
      const port = Number(opt("port") ?? 8080);
      const modelId = opt("model") ?? "none";
      const Database = (await import("better-sqlite3")).default;
      const { LlamaModel } = await import("@modelnativ/model-adapter");
      const { createApp, createServer, loadAppConfig, productionEnv } = await import("@modelnativ/runtime");
      const { DirTraces, FileAudit } = await import("@modelnativ/observability");
      const { EnvSecretStore } = await import("@modelnativ/effect-executor");
      const { config, dir } = await loadAppConfig(appDir);
      let model;
      if (modelId !== "none") {
        const manifest = JSON.parse(readFileSync(join(ROOT, "models", "manifest.json"), "utf8"));
        const m = manifest[modelId];
        if (!m) fail(2, `unknown model ${modelId}; see models/manifest.json`);
        const path = join(ROOT, "models", m.file);
        if (!existsSync(path)) fail(3, `weights missing; run: modelnativ model pull ${modelId}`);
        model = new LlamaModel({ ...m, path }, { decoding: "category", reusePrefix: true });
        await model.warm();
      }
      const stateDir = join(process.cwd(), ".modelnativ");
      const dbPath = opt("db") ?? ":memory:";
      const db = new Database(dbPath);
      const env = productionEnv();
      // Tokens are signed with MN_SECRET_INGRESS_SIGNINGKEY. Without it, refuse to start unless --dev,
      // which uses a random key that lives only as long as this process (never a well-known key).
      const dev = flag("dev");
      if (!process.env.MN_SECRET_INGRESS_SIGNINGKEY && !dev)
        fail(2, "MN_SECRET_INGRESS_SIGNINGKEY is not set. Set it to a long random value (e.g. `openssl rand -hex 32`), or pass --dev for a local demo with an ephemeral key.");
      const secrets = process.env.MN_SECRET_INGRESS_SIGNINGKEY ? new EnvSecretStore() : undefined; // --dev: random per-process key (createApp default)
      let app;
      try {
        app = createApp(config, dir, { env, db, model, secrets, audit: new FileAudit(join(stateDir, "audit.jsonl")), traces: new DirTraces(join(stateDir, "traces")), runSetup: dbPath === ":memory:" || flag("setup") });
      } catch (e) {
        fail(2, (e as Error).message);
      }
      const server = createServer(app.engines, app.identity).listen(port);
      await new Promise<void>((r) => server.once("listening", () => r()));
      const bound = (server.address() as { port: number }).port; // --port 0: the OS picks a free port
      const timer = setInterval(() => void app.dispatcher.drain().catch((e) => console.error("dispatcher:", e.message)), 1000);
      for (const c of app.contracts) console.log(`modelnativ serving POST /v1/${c.name}  (${c.name}@${c.version} sha256:${c.hash.slice(0, 12)}, decision: ${c.source.spec.decision.source?.mode ?? "model"})`);
      console.log(`on :${bound}${model ? ` with model ${model.id}` : " with no model (structured decisions only)"}`);
      if (dev && !process.env.MN_SECRET_INGRESS_SIGNINGKEY) {
        const scopes = config.demo?.principal.scopes ?? [...new Set(app.contracts.flatMap((c) => c.source.spec.principal.scopes))];
        const subject = opt("subject") ?? config.demo?.principal.subject;
        const tenant = opt("tenant") ?? config.demo?.principal.tenant;
        console.log("DEV MODE: ephemeral signing key (tokens die with this process). Do not expose this server.");
        if (subject && tenant) {
          const token = app.identity.issue({ subject, tenant, sessionId: "demo", scopes }, 3_600_000);
          console.log(`demo token (subject ${subject}, tenant ${tenant}, 1h):\n  ${token}`);
          const op = config.demo?.operation ?? app.contracts[0]!.name;
          if (config.demo?.request)
            console.log(`try:\n  curl -s localhost:${bound}/v1/${op} -H "authorization: Bearer ${token}" -H "idempotency-key: demo-$(date +%s)" -H "content-type: application/json" -d '${JSON.stringify(config.demo.request)}'`);
        } else console.log("no demo principal: pass --subject and --tenant, or add `demo` to modelnativ.config.ts");
      }
      const stop = () => (clearInterval(timer), server.close(() => process.exit(0)), setTimeout(() => process.exit(0), 5_000).unref());
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    default:
      fail(2, `unknown command "${cmd}"`, { help: HELP });
  }
}

main().catch((e) => fail(1, (e as Error).message));
