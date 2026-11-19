# Security policy

Modelnativ is a **developer preview**. It is not intended for production use, and no version is supported for production workloads.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's **"Report a vulnerability"** button on this repository's **Security** tab (private vulnerability reporting). Include:

- the affected commit;
- the steps to reproduce;
- the impact you expect.

We aim to acknowledge reports within a week. We will discuss a fix and disclosure timeline with you.

## Scope worth knowing

- **Authentication.** `modelnativ serve` signs tokens with `MN_SECRET_INGRESS_SIGNINGKEY`, and refuses to start without it unless `--dev` is passed. **`--dev` is for local experiments only:** its key is random and ephemeral, and the server prints a demo token.
- **Network exposure.** The standalone server is a development server. It has no TLS, no request limits and no graceful drain. Do not expose it to untrusted networks.
- **Secrets.** Secrets are read per use from the configured `SecretStore` (environment variables by default in `serve`). They are never written to audit records, traces or the outbox. The test suite checks this.
