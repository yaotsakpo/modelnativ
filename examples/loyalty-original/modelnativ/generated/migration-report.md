# Migration report: RedemptionService.redeem -> loyalty.redeem

Source: service.ts:15-41; call graph: RedemptionService.redeem
Decision source: **fixed** (no model-suitable judgment: deterministic)

## What was found
| Kind | Count |
|---|---|
| authorization | 0 |
| invariant | 5 |
| existence | 2 |
| read | 3 |
| effect | 4 |
| judgment | 0 |
| unknown | 0 |

## Precedence (original order; first failure decides)
| # | Line | Kind | Code | Candidate rule |
|---|---|---|---|---|
| 1 | 20 | existence | not_found | **manual** |
| 2 | 21 | invariant | inactive | `acct.status == 'active'` |
| 3 | 25 | existence | not_found | **manual** |
| 4 | 26 | invariant | tier_required | **manual** |
| 5 | 27 | invariant | out_of_stock | `reward.stock >= request.quantity` |
| 6 | 29 | invariant | insufficient_points | **manual** |
| 7 | 31 | invariant | daily_limit | **manual** |

## Outcomes
| Original | Reason | Modelnativ |
|---|---|---|
| rejected | not_found | REFUSE (reason `not_found`) |
| rejected | inactive | REFUSE (reason `inactive`) |
| rejected | not_found | REFUSE (reason `not_found`) |
| rejected | tier_required | REFUSE (reason `tier_required`) |
| rejected | out_of_stock | REFUSE (reason `out_of_stock`) |
| rejected | insufficient_points | REFUSE (reason `insufficient_points`) |
| rejected | daily_limit | REFUSE (reason `daily_limit`) |
| redeemed |  | ALLOW |

## Assumptions in the original
- Idempotency: NONE in the original: a retried request repeats the effect. Modelnativ requires an Idempotency-Key, so callers must send one.
- Concurrency: NO version check in the original writes: concurrent requests rely on the transaction alone. The adapter must guard each write.
- Transaction: the original wraps reads + writes in one transaction

## Manual items (11)
- [ ] Confirm "member" is the authenticated caller (mapped to principal.subject / principal.tenant).
- [ ] Input schema: number: integer or not? (money and counts are usually integers)
- [ ] service.ts:30 read argument `this.now() - 86_400_000` is computed; compute it inside the read tool.
- [ ] service.ts:26 rule could not be translated: if (TIER_RANK[acct.tier]! < TIER_RANK[reward.min_tier]!) { status: "rejected", r
- [ ] service.ts:29 rule could not be translated: if (acct.points < total) { status: "rejected", reason: "insufficient_points" }
- [ ] service.ts:31 rule could not be translated: if (today >= DAILY_LIMIT) { status: "rejected", reason: "daily_limit" }
- [ ] Effects: name the effect arguments and their sources; the adapter scaffold lists the original writes.
- [ ] Invariants: bound every caller-supplied amount (the generator never invents limits).
- [ ] Authority grants are proposed from which tool reads which table: confirm each table is authoritative for those facts.
- [ ] RedemptionService.redeem is synchronous (returns RedeemResult); Modelnativ execution is async, so every caller must `await` the replacement.
- [ ] The original makes an outbound call outside its transaction (fire-and-forget). The migration sends it via the outbox: delivery becomes at-least-once AFTER commit. This is an intended behaviour change; confirm it.

## Unsupported constructs
- none

> No model-suitable judgment found: every decision here is deterministic. Migrating gains framework guarantees (idempotency, outbox, audit, replay) but no model role; consider keeping it conventional.