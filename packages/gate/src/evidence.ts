/**
 * Evidence: the per-operation PSAP store.
 *
 * Every fact the kernel reads is MINTED through the vendored PSAP resolver on the
 * channel it arrived on. Contract grants become PSAP capabilities bound to those
 * channels. The model writes on the agent-self channel, which no capability
 * binds, so anything the model states is PROPOSING by construction.
 *
 * `established(p)` is the only way the gate reads a fact, and it returns a value
 * only when the operative assertion for `p` is ESTABLISHING. A claim from a
 * channel without a grant (a customer saying "it arrived broken") is stored and
 * visible in the audit trace, but it is never returned here.
 */
import type { CompiledContract } from "@modelnativ/contract-compiler";
import type { Principal } from "@modelnativ/contract-schema";
import {
  emptyStore,
  mint,
  operative,
  type Assertion,
  type AuthorityClass,
  type Capability,
  type ChannelContext,
  type OperativeResult,
} from "./psap-authority.ts";

export type Channel = { kind: "principal" } | { kind: "tool"; tool: string } | { kind: "model" };

export function channelContext(ch: Channel, principal: Principal): ChannelContext {
  switch (ch.kind) {
    case "principal":
      return {
        principalId: `principal:${principal.subject}`,
        channelId: `chan:principal-verified/${principal.subject}`,
        trustDomain: principal.tenant,
      };
    case "tool":
      return { principalId: `tool:${ch.tool}`, channelId: `chan:tool/${ch.tool}`, trustDomain: principal.tenant };
    case "model":
      // Same shape as PSAP's agentSelfChannel: no capability is ever bound here.
      return { principalId: "principal:agent", channelId: "chan:agent-self", trustDomain: principal.tenant };
  }
}

export class Evidence {
  readonly subject: string;
  private store;
  private seq = 0;

  constructor(
    readonly contract: CompiledContract,
    readonly principal: Principal,
    readonly operationId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.subject = `op:${operationId}`;
    const t = this.now();
    const notBefore = new Date(t.getTime() - 60_000);
    const notAfter = new Date(t.getTime() + 15 * 60_000);
    const caps: Capability[] = contract.source.spec.authority.map((g) => {
      const ctx =
        g.channel === "principal"
          ? channelContext({ kind: "principal" }, principal)
          : channelContext({ kind: "tool", tool: g.channel.slice(5) }, principal);
      return {
        capabilityId: g.id,
        issuer: `contract:${contract.name}@${contract.version}`,
        trustDomain: principal.tenant,
        principalId: ctx.principalId!,
        authorityClass: "ESTABLISHING",
        predicateScope: g.predicates,
        // Grants are scoped to THIS operation only.
        subjectScope: { match: "exact", value: this.subject },
        channelBinding: [ctx.channelId],
        notBefore,
        notAfter,
        policyVersion: contract.hash,
      };
    });
    this.store = emptyStore(caps);
  }

  /** Mint one value on a channel. Returns the derived class. */
  record(channel: Channel, predicate: string, value: unknown): Assertion {
    const r = mint(
      this.store,
      { subject: this.subject, predicate, object: value },
      channelContext(channel, this.principal),
      this.now(),
      { assertionId: `${this.operationId}/${String(++this.seq).padStart(3, "0")}` },
    );
    if ("rejected" in r) throw new Error(`mint rejected: ${r.rejected}`);
    return r;
  }

  operative(predicate: string): OperativeResult | null {
    return operative(this.store, this.subject, predicate, this.now());
  }

  /** The value of `predicate` iff its operative assertion is ESTABLISHING. */
  established(predicate: string): { value: unknown; assertionId: string; capabilityId: string | null } | undefined {
    const op = this.operative(predicate);
    if (!op || op.class !== "ESTABLISHING") return undefined;
    return { value: op.value, assertionId: op.assertionId, capabilityId: op.capabilityId };
  }

  classOf(predicate: string): AuthorityClass | null {
    return this.operative(predicate)?.class ?? null;
  }

  /** For audit: every assertion with its derived class and channel; values omitted. */
  trace(): { id: string; predicate: string; class: AuthorityClass; via: string }[] {
    return this.store.assertions.map((a) => ({
      id: a.assertionId,
      predicate: a.predicate,
      class: a.authority.class,
      via: a.ingestedVia,
    }));
  }
}
