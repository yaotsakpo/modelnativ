/** Compare a concise contract's expansion with a hand-written explicit contract, ignoring documentation-only fields and grant ids. */
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { expandShorthand } from "@modelnativ/contract-compiler";

const DOC_ONLY = new Set(["description", "summary", "title", "examples", "notes"]);
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !DOC_ONLY.has(k)).map(([k, x]) => [k, strip(x)]));
  return v;
}
/** Grants are named by the author in explicit contracts and `cap.<tool>` by the expander: key them by channel. */
function normalise(doc: Record<string, any>) {
  const d = strip(structuredClone(doc)) as Record<string, any>;
  d.spec.authority = Object.fromEntries((d.spec.authority ?? []).map((g: { channel: string; predicates: string[] }) => [g.channel, [...g.predicates].sort()]));
  return d;
}
export function compare(conciseFile: string, explicitFile: string): string[] {
  const c = normalise(expandShorthand(YAML.parse(readFileSync(conciseFile, "utf8"))));
  const a = normalise(YAML.parse(readFileSync(explicitFile, "utf8")));
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as any)[k], (y as any)[k], `${path}.${k}`);
      return;
    }
    diffs.push(`${path}: concise=${JSON.stringify(x)} explicit=${JSON.stringify(y)}`);
  };
  walk(c, a, "");
  return diffs;
}
