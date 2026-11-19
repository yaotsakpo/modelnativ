# Migration report: createLegacyRefundService.requestRefund -> refund.request

Source: app.ts:24-37; call graph: createLegacyRefundService.requestRefund -> loadOrder -> decideRefund
Decision source: **hybrid** (branch on caller-chosen `reason`: DAMAGED, NOT_DELIVERED, CHANGED_MIND)

## What was found
| Kind | Count |
|---|---|
| authorization | 2 |
| invariant | 8 |
| existence | 2 |
| read | 2 |
| effect | 2 |
| judgment | 1 |
| unknown | 0 |

## Precedence (original order; first failure decides)
| # | Line | Kind | Code | Candidate rule |
|---|---|---|---|---|
| 1 | 30 | invariant |  | **manual** |
| 2 | 18 | authorization | not_found | **manual** |
| 3 | 19 | authorization | forbidden | `order.ownerId == principal.subject` |
| 4 | 20 | invariant | nothing_to_refund | `order.refundableCents > 0` |
| 5 | 21 | invariant | over_limit | `order.refundableCents <= 50000` |
| 6 | 24 | invariant | too_old | `order.ageDays <= 60` |
| 7 | 25 | existence | needs_damage_report | **manual** |
| 8 | 26 | invariant | carrier_says_intact | `carrier.damaged == true` |
| 9 | 29 | invariant | too_old | `order.ageDays <= 45` |
| 10 | 30 | existence | needs_tracking | **manual** |
| 11 | 31 | invariant | carrier_says_delivered | `carrier.delivered == false` |
| 12 | 34 | invariant | too_old | `order.ageDays <= 30` |

## Outcomes
| Original | Reason | Modelnativ |
|---|---|---|
| REFUSE | not_found | REFUSE (reason `not_found`) |
| REFUSE | forbidden | REFUSE (reason `forbidden`) |
| REFUSE | nothing_to_refund | REFUSE (reason `nothing_to_refund`) |
| REFUSE | over_limit | REFUSE (reason `over_limit`) |
| REFUSE | too_old | REFUSE (reason `too_old`) |
| REVIEW | needs_damage_report | REVIEW (reason `needs_damage_report`) |
| REFUSE | carrier_says_intact | REFUSE (reason `carrier_says_intact`) |
| ALLOW |  | ALLOW |
| REFUSE | too_old | REFUSE (reason `too_old`) |
| REVIEW | needs_tracking | REVIEW (reason `needs_tracking`) |
| REFUSE | carrier_says_delivered | REFUSE (reason `carrier_says_delivered`) |
| ALLOW |  | ALLOW |
| REFUSE | too_old | REFUSE (reason `too_old`) |
| ALLOW |  | ALLOW |
| REVIEW | other | REVIEW (reason `other`) |

## Assumptions in the original
- Idempotency: NONE in the original: a retried request repeats the effect. Modelnativ requires an Idempotency-Key, so callers must send one.
- Concurrency: version-checked writes
- Transaction: the original wraps reads + writes in one transaction

## Manual items (8)
- [ ] Confirm "user" is the authenticated caller (mapped to principal.subject / principal.tenant).
- [ ] app.ts:20 read argument `id` is computed; compute it inside the read tool.
- [ ] app.ts:20 `SELECT * FROM orders WHERE id=?…`: SELECT * or computed columns. List the facts this read provides.
- [ ] app.ts:30 rule could not be translated: if (d.outcome !== "ALLOW") d
- [ ] policy.ts:18 rule could not be translated: if (!order || order.tenantId !== user.tenantId) { outcome: "REFUSE", reason: "no
- [ ] Effects: name the effect arguments and their sources; the adapter scaffold lists the original writes.
- [ ] Invariants: bound every caller-supplied amount (the generator never invents limits).
- [ ] Authority grants are proposed from which tool reads which table: confirm each table is authoritative for those facts.

## Unsupported constructs
- none