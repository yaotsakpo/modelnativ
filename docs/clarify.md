# CLARIFY: asking the caller instead of guessing

## Outcomes

| Outcome | Meaning | HTTP |
|---|---|---|
| ALLOW | Executed (effect committed) | 201 (200 for a duplicate) |
| REFUSE | A policy, authority or state violation; never retried, never clarified | 4xx/5xx by code |
| REVIEW | A human must decide | 202 |
| **CLARIFY** | The caller must say more; nothing executed; resume with the token | 202 |

## Contract (optional; operations without it behave exactly as before)

```yaml
input:
  properties:
    clarification: { type: string, maxLength: 1200 }   # the answer arrives as a request field
facts:
  - tool: request
    provides: [request.orderId, request.message, request.clarification]
model:
  sees: [request.message, request.clarification]
decision:
  evidence: { from: [request.message, request.clarification] }
  categories:
    CHANGED_MIND:
      clarifyAs: "I no longer want the item, and nothing is wrong with it"   # caller-facing choice
clarify:
  on: [INTENT_NOT_ESTABLISHED, INTENT_UNCONFIRMED, INTENT_UNGROUNDED, MODEL_REQUESTED_REVIEW]
  field: request.clarification
  question: "To process your request, which of these best describes the reason?"
  choices: categories        # one per non-abstain category + "None of these"
  allowText: true
  ttlSeconds: 86400
  maxRounds: 1
```

The compiler rejects:
- `clarify` without an intent policy;
- a field that is not a request fact, not an evidence source, or not a string in the input schema;
- a trigger outside the four intent codes. A missing *fact* (e.g. a carrier report) or a policy refusal can never become a question.

## The flow

1. **CLARIFY instead of REVIEW.** The gate's decision is REVIEW with a configured intent code, and the round is below `maxRounds`. The runtime persists a pending operation in `mn_pending`, in the same database as effects. The row holds:
   - **only the sha256 of a single-use token** (CSPRNG in production);
   - tenant, principal, operation, contract hash and idempotency key;
   - the request, and the original request hash;
   - the round, status and expiry.

   It returns CLARIFY with the token, the question, the choices and the expiry. Nothing executes; the token never enters audit or traces.
2. **Resume.** The caller sends the token plus a choice and/or text: `POST /v1/<op>/resume`, `engine.resume()`, or `mn.resume()` in the SDK.
   - **The answer is validated first.** A malformed answer does not consume the token.
   - **One conditional `UPDATE` claims the row**, matching hash, `status='pending'`, tenant, principal, operation, contract hash and expiry. Any mismatch yields the same `CLARIFICATION_INVALID`, so there is no oracle for which check failed.
3. **The whole pipeline reruns.** The answer is appended to the request as the caller's own words, and the original request goes back through:
   - fresh tenant-scoped reads and PSAP minting;
   - a new model proposal and the full intent policy (level, grounding, both-polarity confirmation on message plus answer);
   - the gate;
   - a version-checked commit under the original idempotency key and request hash.

## Guarantees and how they are tested (`tests/adversarial/clarify.test.ts`, 17 tests)

| Guarantee | Mechanism | Test |
|---|---|---|
| Clarification never authorizes by itself | Resume = a full re-run; the answer is only a request fact on the caller's channel | An ineligible order is still refused; a missing carrier fact is still REVIEW |
| Resume = stating it upfront | Same code path | Property test: a resumed outcome equals a fresh request with the same text |
| No replay | Single-use atomic claim | Second resume → `CLARIFICATION_INVALID`; one effect |
| No cross-tenant or cross-principal continuation | Claim filters tenant + principal | Other principal or tenant refused; the owner still succeeds |
| No duplicate effects | Original idempotency key + hash; concurrent claims → one winner | Concurrent resumes: one ALLOW; a retry of the original returns the duplicate |
| No stale-state execution | Fresh reads; version check | Balance drained while waiting → refused |
| Contract changes fail closed | Contract hash in the claim | Changed hash → invalid |
| Answers cannot launder intent | Confirmation reads message + answer | "Exchange for size L" + "I no longer want it" → REVIEW |
| Bounded | `maxRounds`, TTL | Still unclear → REVIEW; expired → invalid |

Mutation check: removing any claim condition (tenant, principal, single-use, expiry, contract hash) fails at least one test.

## What clarification does *not* do

It lets the caller state their reason explicitly, the way a traditional form's dropdown does. **A lying caller can still choose the most permissive reason.** The protection against that is the same as in a traditional service: the category's rules (CHANGED_MIND only within 30 days), plus consistency with the original message (the confirmation questions). The evaluation measures both honest and adversarial callers.

## Evaluation

Model: Qwen2.5 1.5B (experimental baseline), category decoding, prefix reuse.

**Simulated callers** answer the clarification question:
- *honest*: with the reason they would actually give (the case's `trueReason`; "None of these" when there is none);
- *adversarial*: always the most permissive choice (CHANGED_MIND).

**The reference** is the original handwritten service given that true reason. A vague but genuine request ("refund pls" from someone whose item is broken) therefore counts as legitimate, and completing it after asking is correct.

### Dev (dev-v2, 200 cases; reference = label)

| Config | Legit done (/74) | Unwanted | Asked | p50 / p95 |
|---|---|---|---|---|
| no policy | 45 | 19 | – | 0.65 / 1.3 s |
| intent policy | 29 | 5 | – | 2.1 / 3.2 s |
| + CLARIFY, honest | 54 | 4 | 93 | 1.5 / 3.4 s |
| + CLARIFY, adversarial | 39 | 15 | 93 | 2.6 / 6.7 s |

### Sealed (sealed-v3, 200 cases, run once; configurations pre-registered in `798a87a`)

| Config | Legit done (/101) | Unwanted | Contract violations | Asked | p50 / p95 (incl. resume) |
|---|---|---|---|---|---|
| A. no policy | 72 | 19 | 0 | – | 0.85 / 1.3 s |
| D. intent policy | 31 | **0** | 0 | – | 2.2 / 3.1 s |
| **E. + CLARIFY, honest caller** | **49** | **0** | 0 | 116 | 3.8 / 6.3 s |
| F. + CLARIFY, adversarial caller | 33 | 3 | 0 | 116 | 5.1 / 6.5 s |

**Findings:**
1. **CLARIFY improves legitimate completion without increasing unwanted effects** for honest callers: 31 → 49 of 101, with unwanted staying at 0 on the sealed set.
2. **Adversarial callers gain little.** The two-polarity confirmation reads the original message plus the answer and rejected 107 of 116 permissive answers as inconsistent. The 3 approvals that got through are all within what the caller's own stated reason permits under the reference policy (`approvalsBeyondCallersOwnStatement: 0`), the same exposure as a traditional form.
3. **The remaining gap is confirmation reliability, not clarification.** After an honest answer, 74 of 116 still end in `INTENT_UNCONFIRMED`: the 1.5B model's yes/no answers on the combined text are noisy. Completion is capped by the confirmation model, not by the workflow.
4. **Latency:** a clarified request costs a second full round (fresh reads, proposal, confirmations): about 3.8 s p50 end to end, excluding the human's answer time.

**Options to close the remaining gap** (not implemented; each needs a decision):
- **(a)** When the caller *selected* a choice, ask only the consistency question (`expect: no`), not the positive one: the caller has literally said it. This would be a declarative contract option, e.g. `confirmOnClarify: consistency-only`. It relaxes the policy for explicit caller statements only. I have not done it because it is a policy change.
- **(b)** A stronger confirmation model (Llama 3B was more discriminating on dev) used only for `ask()`: a split-model adapter.
- **(c)** More dev data and confirmation-wording iteration on dev-v2.
