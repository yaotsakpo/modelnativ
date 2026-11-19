/**
 * One runtime instance in its own OS process: opens the shared SQLite file, waits for a common
 * start instant, sends one loyalty redemption with the given idempotency key, prints the result.
 * Fact reads are slowed by 150 ms so the two processes' operations overlap.
 *   node --import tsx idem-child.ts <db-file> <idempotency-key> <start-at-ms>
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { CryptoRandom, NO_FAULTS, createApp, freeScheduler, systemClock, type ReadTool } from "@modelnativ/runtime";
import loyaltyC from "../../../examples/loyalty-original/modelnativ/c/modelnativ.config.ts";

const [file, key, startAt] = process.argv.slice(2) as [string, string, string];
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const env = { clock: systemClock, random: new CryptoRandom(), scheduler: freeScheduler, faults: NO_FAULTS };
const config = { ...loyaltyC, destinations: () => [], tools: (ctx: Parameters<typeof loyaltyC.tools>[0]) => loyaltyC.tools(ctx).map((t): ReadTool => ({ ...t, read: async (a, c) => (await systemClock.sleep(150), t.read(a, c)) })) };
const app = createApp(config, join(import.meta.dirname, "../../../examples/loyalty-original/modelnativ/c"), { env, db });
const NOW = Date.now();
const keepAlive = setInterval(() => {}, 1_000); // the runtime's timers are unref'd
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
const r = await app.engines[0]!.handle({ principal: { subject: "m_1", tenant: "t_a", sessionId: "s", scopes: ["loyalty:redeem"], expiresAt: NOW + 3_600_000 }, body: { rewardId: "rw_1", quantity: 1 }, idempotencyKey: key });
process.stdout.write(JSON.stringify(r) + "\n");
db.close();
clearInterval(keepAlive);
