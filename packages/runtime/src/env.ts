/**
 * The execution environment. Every source of nondeterminism the kernel touches
 * (time, randomness, ids, scheduling, faults) comes through here, so a test can
 * replace all of it and an identical input produces an identical execution.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// ------------------------------------------------------------------ clock

export interface Clock {
  now(): number;
  /** Resolves after `ms` of THIS clock's time. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
};

/** Time moves only when the test says so. */
export class VirtualClock implements Clock {
  private t: number;
  private sleepers: { at: number; resolve: () => void }[] = [];
  constructor(start = Date.UTC(2026, 10, 16, 12, 0, 0)) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.sleepers.push({ at: this.t + ms, resolve }));
  }
  /** Jump to the earliest pending sleeper and wake it. Returns false when nothing is pending. */
  advanceToNext(): boolean {
    if (!this.sleepers.length) return false;
    const next = Math.min(...this.sleepers.map((s) => s.at));
    this.advance(Math.max(0, next - this.t));
    return true;
  }
  get pending(): number {
    return this.sleepers.length;
  }
  advance(ms: number) {
    this.t += ms;
    const due = this.sleepers.filter((s) => s.at <= this.t);
    this.sleepers = this.sleepers.filter((s) => s.at > this.t);
    for (const s of due) s.resolve();
  }
}

// ------------------------------------------------------------------ randomness

/** mulberry32: small, fast, seedable. Not for cryptography; ids only. */
export class SeededRandom {
  private s: number;
  constructor(readonly seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  id(prefix: string): string {
    let out = "";
    for (let i = 0; i < 12; i++) out += "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(this.next() * 36)];
    return `${prefix}_${out}`;
  }
}

/** Production ids: 96 bits from the OS CSPRNG. Same interface as SeededRandom. */
export class CryptoRandom extends SeededRandom {
  constructor() {
    super(randomBytes(4).readUInt32LE(0));
  }
  override id(prefix: string): string {
    return `${prefix}_${randomBytes(12).toString("base64url")}`;
  }
}

// ------------------------------------------------------------------ faults

export class InjectedFault extends Error {
  constructor(readonly point: string, readonly kind: FaultKind) {
    super(`injected ${kind} at ${point}`);
  }
  /** Network blips and timeouts are transient; crashes and DB failures are not retried in-process. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "timeout";
  }
}
/** A failure re-raised from a trace during replay; its message is the recorded detail verbatim. */
export class ReplayedFailure extends Error {}
export type FaultKind = "crash" | "network" | "timeout" | "db";

/** Named fault points. Production uses NO_FAULTS; tests arm specific points. */
export interface Faults {
  check(point: string): void;
}
export const NO_FAULTS: Faults = { check() {} };

export class FaultPlan implements Faults {
  private armed = new Map<string, { kind: FaultKind; times: number }>();
  readonly hits: string[] = [];
  arm(point: string, kind: FaultKind, times = 1) {
    this.armed.set(point, { kind, times });
    return this;
  }
  check(point: string) {
    const a = this.armed.get(point);
    if (!a || a.times <= 0) return;
    a.times--;
    this.hits.push(point);
    throw new InjectedFault(point, a.kind);
  }
}

// ------------------------------------------------------------------ scheduler

/**
 * Yield points mark where concurrent operations may interleave (between reads,
 * model call, gate and commit). The real scheduler does nothing; the controlled
 * scheduler parks the task and lets a test pick who runs next.
 */
export interface Scheduler {
  yield(point: string): Promise<void>;
}
export const freeScheduler: Scheduler = { yield: async () => {} };

type Parked = { task: string; point: string; resume: () => void };

export class ControlledScheduler implements Scheduler {
  private als = new AsyncLocalStorage<string>();
  private parked: Parked[] = [];
  readonly log: string[] = [];
  /** When every task is idle and only timers remain, jump this clock to the next timer (deterministic). */
  clock?: VirtualClock;

  async yield(point: string): Promise<void> {
    const task = this.als.getStore();
    if (!task) return; // not under control (setup code)
    await new Promise<void>((resume) => this.parked.push({ task, point, resume }));
  }

  /**
   * Run tasks to completion. At each step every live task is parked or done;
   * `choose` picks which parked task resumes. Returns per-task results, or
   * `deadlock` when unfinished tasks exist but none is parked.
   */
  async run<T>(
    tasks: Record<string, () => Promise<T>>,
    choose: (step: number, enabled: Parked[]) => number,
  ): Promise<{ results: Record<string, T | Error>; deadlock: boolean; schedule: string[] }> {
    const results: Record<string, T | Error> = {};
    const done = new Set<string>();
    const names = Object.keys(tasks).sort();
    for (const name of names) {
      this.als.run(name, () => {
        tasks[name]!().then(
          (v) => ((results[name] = v), done.add(name)),
          (e) => ((results[name] = e instanceof Error ? e : new Error(String(e))), done.add(name)),
        );
      });
    }
    const schedule: string[] = [];
    for (let step = 0; ; step++) {
      await quiesce();
      if (done.size === names.length) return { results, deadlock: false, schedule };
      if (this.parked.length === 0) {
        if (this.clock?.advanceToNext()) {
          schedule.push("clock");
          continue;
        }
        return { results, deadlock: true, schedule };
      }
      const enabled = [...this.parked].sort((a, b) => (a.task < b.task ? -1 : 1));
      const i = choose(step, enabled);
      const pick = enabled[Math.min(Math.max(i, 0), enabled.length - 1)]!;
      this.parked = this.parked.filter((p) => p !== pick);
      const label = `${pick.task}@${pick.point}`;
      schedule.push(label);
      this.log.push(label);
      pick.resume();
    }
  }
}

/** Let all pending microtasks and immediates settle (no real I/O in the kernel under test). */
async function quiesce() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Systematic exploration: depth-first over every scheduling choice, without
 * relying on a seed. Each run replays a choice prefix and then takes the first
 * option; afterwards the deepest choice with an untried alternative is bumped.
 */
export async function exploreSchedules<T>(
  makeTasks: () => Promise<{ tasks: Record<string, () => Promise<T>>; check: (r: Awaited<ReturnType<ControlledScheduler["run"]>>, s: ControlledScheduler) => void | Promise<void>; scheduler: ControlledScheduler }>,
  opts: { maxSchedules?: number } = {},
): Promise<{ explored: number; exhaustive: boolean }> {
  const max = opts.maxSchedules ?? 5000;
  let prefix: number[] = [];
  let explored = 0;
  while (explored < max) {
    const widths: number[] = [];
    const { tasks, check, scheduler } = await makeTasks();
    const r = await scheduler.run(tasks, (step, enabled) => {
      widths[step] = enabled.length;
      return step < prefix.length ? prefix[step]! : 0;
    });
    explored++;
    await check(r as never, scheduler);
    // backtrack
    const taken = widths.map((_, i) => (i < prefix.length ? prefix[i]! : 0));
    let k = taken.length - 1;
    while (k >= 0 && taken[k]! + 1 >= widths[k]!) k--;
    if (k < 0) return { explored, exhaustive: true };
    prefix = [...taken.slice(0, k), taken[k]! + 1];
  }
  return { explored, exhaustive: false };
}

// ------------------------------------------------------------------ env

/** Optional stage timings. Observational only: never read by any decision. */
export interface Profiler {
  span(stage: string, ms: number): void;
}
export class StageProfiler implements Profiler {
  readonly samples = new Map<string, number[]>();
  span(stage: string, ms: number) {
    const a = this.samples.get(stage) ?? [];
    a.push(ms);
    this.samples.set(stage, a);
  }
  summary(): Record<string, { n: number; p50: number; p95: number; mean: number }> {
    const out: Record<string, { n: number; p50: number; p95: number; mean: number }> = {};
    for (const [k, v] of this.samples) {
      const s = [...v].sort((a, b) => a - b);
      const at = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3);
      out[k] = { n: s.length, p50: at(0.5), p95: at(0.95), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) };
    }
    return out;
  }
}

export type Env = {
  clock: Clock;
  random: SeededRandom;
  scheduler: Scheduler;
  faults: Faults;
  profile?: Profiler;
};

export function productionEnv(): Env {
  return { clock: systemClock, random: new CryptoRandom(), scheduler: freeScheduler, faults: NO_FAULTS };
}

export function testEnv(seed = 1, extra: Partial<Env> = {}): Env & { clock: VirtualClock } {
  const clock = extra.clock instanceof VirtualClock ? extra.clock : new VirtualClock();
  if (extra.scheduler instanceof ControlledScheduler && !extra.scheduler.clock) extra.scheduler.clock = clock;
  return {
    clock,
    random: new SeededRandom(seed),
    scheduler: freeScheduler,
    faults: NO_FAULTS,
    ...extra,
  } as Env & { clock: VirtualClock };
}

/**
 * Drive a promise to completion under a VirtualClock: whenever the program is idle,
 * jump to the next timer. Deterministic; `maxSteps` guards against livelock.
 */
export async function drive<T>(p: Promise<T>, clock: VirtualClock, maxSteps = 10_000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => ((settled = true), (value = v)),
    (e) => ((settled = true), (error = e)),
  );
  for (let i = 0; i < maxSteps; i++) {
    for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
    if (settled) break;
    if (!clock.advanceToNext()) {
      for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
      if (settled) break;
      throw new Error("drive: program is blocked with no pending timers");
    }
  }
  if (!settled) throw new Error("drive: step limit reached");
  if (error !== undefined) throw error;
  return value as T;
}
