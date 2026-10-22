# Security Policy

## Reporting a Vulnerability

We take the security of `mctl-alice` and our users' smart homes seriously. If you believe you have found a security vulnerability, please report it to us responsibly before public disclosure.

**Security Contact:** [security@mctl.ai](mailto:security@mctl.ai)

Please include in your report:
1. Description of the vulnerability and its potential impact.
2. Steps to reproduce or proof-of-concept.
3. Affected components, endpoints, or versions.

We strive to acknowledge receipt of security vulnerability reports within 24 hours and provide an estimated remediation timeline within 72 hours.

---

## Safe Harbor for Security Researchers

We consider security research conducted in accordance with this policy to be authorized and protected:
- We will not pursue civil or criminal action against researchers who make a good-faith effort to avoid privacy violations, data destruction, and service interruption.
- Please do not access or modify data belonging to other users. Test vulnerabilities only against accounts you own.
- Please give us reasonable time to resolve the vulnerability before any public disclosure.

---

## Threat Model & Cryptographic Guarantees

### Multi-Tenant Isolation
- Upstream OAuth tokens and Quasar session cookies are encrypted at rest using **AES-256-GCM**.
- The `userId` is passed as Additional Authenticated Data (AAD) into AES-GCM encryption and decryption. This ensures cryptographic binding: ciphertext generated for Tenant A cannot be substituted or injected into Tenant B's record.
- Every API and MCP tool invocation validates token ownership and grants explicit granular scopes (`iot:view`, `iot:control`, `quasar`).

### Operator Boundary Transparency
- As a proxying server, `mctl-alice` must decrypt upstream tokens into process memory at the moment of request execution to communicate with Yandex Smart Home (`iot.yandex.net`) and Yandex Quasar (`iot.quasar.yandex.ru`).
- We do not make false "zero-knowledge" marketing claims: an operator with root access to the host or runtime memory could inspect memory contents. Security at rest and multi-tenant isolation protect against database leaks, backup exposures, and inter-tenant access.

### Request Bounds
- Every request body is read through one capped reader: 64 KiB for OAuth, account and sign-in forms, and 1 MiB for MCP and REST JSON (`MAX_MCP_BODY_BYTES`). A larger declared `Content-Length` gets `413` without reading the body; a streamed body is cut off at the cap with `413` and `Connection: close`.
- Per-client sliding-window limits (requests per 60 s, kept in process memory, at most 10,000 keys per bucket) answer `429` with `Retry-After`: `/oauth/register` 10, `/oauth/token` 30, `/oauth/authorize` 30, the sign-in group 30 (`/auth/qr-code` 10), and the MCP group (`/mcp`, `/sse`, `/messages`, `/api/*`) 300, keyed by token fingerprint when a bearer token is present. Override with `RATE_LIMIT_REGISTER`, `RATE_LIMIT_TOKEN`, `RATE_LIMIT_AUTHORIZE`, `RATE_LIMIT_LOGIN`, `RATE_LIMIT_QR` and `RATE_LIMIT_MCP`. `/healthz` and `/readyz` are never limited.
- The client address is the socket address. Set `CLIENT_IP_HEADER` to take it from a single-valued header the proxy overwrites (`cf-connecting-ip` behind Cloudflare; a missing or multi-valued header falls back to the next rule), or `TRUST_PROXY_HOPS=N` to use the N-th entry from the right of `X-Forwarded-For`. Use either only behind a proxy you control: otherwise clients can choose their own rate-limit key. While both are unset, all anonymous traffic behind an ingress shares one address bucket. The hosted instance sits behind Cloudflare and a Traefik that rewrites `X-Forwarded-For` to the Cloudflare edge address, so it uses `CLIENT_IP_HEADER=cf-connecting-ip`.
- Every call to Yandex has a deadline (10 s, 15 s for the Smart Home API). A timeout is reported as `504` naming the upstream, and upstream errors carry only the HTTP status and a short sanitized message, never the raw response body. Account deletion and Quasar disconnection stop cleaning up scenarios after 20 s, finish anyway and report that scenarios were left.

### Quasar Smart Speaker Automation Scenarios
- Yandex Quasar speaker command execution operates by creating temporary automation scenarios in Yandex Cloud. These scenarios reside on Yandex servers until overwritten or pruned upon account/speaker disconnect.
