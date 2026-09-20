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

### Quasar Smart Speaker Automation Scenarios
- Yandex Quasar speaker command execution operates by creating temporary automation scenarios in Yandex Cloud. These scenarios reside on Yandex servers until overwritten or pruned upon account/speaker disconnect.
