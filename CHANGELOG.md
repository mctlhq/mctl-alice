# Changelog

Versions follow semantic versioning; tags carry no `v` prefix. Full notes for
every version are on the [Releases page](https://github.com/mctlhq/mctl-alice/releases).

## 2.2.8 (2026-10-22)

- Request bodies are capped (64 KiB for forms, 1 MiB for MCP, 413 above),
  sign-in, OAuth and MCP endpoints are rate limited (429 with `Retry-After`),
  JSON-RPC batches are bounded, and every Yandex call has a timeout (504) with
  sanitized error text (502) (#75, closes #74).
- Honest data-flow and privacy text, a data inventory with retention, a
  non-affiliation disclaimer, corrected README tool list (#78).

## 2.2.7 (2026-10-22)

- Database restore runbook and the read-only `restore-check` tool (#73).

## 2.2.6 (2026-10-21)

- Self-hosted mode accepts browser requests and form posts only from its own
  origin or a loopback host; every sign-in is a one-time transaction bound to
  the browser that started it; the CLI auth helper listens on 127.0.0.1 only.

## 2.2.5 (2026-10-21)

- Encryption key ids (`ENCRYPTION_KEYS`, `ENCRYPTION_KEY_ID`) and an opt-in
  re-encryption pass for key rotation (#68).

## 2.2.4 (2026-10-21)

- Content-Security-Policy without `unsafe-inline`, CORS limited to the API
  endpoints, no shell in the local CLI, fail-closed decryption (#65).

## 2.2.3 (2026-10-21)

- Bearer secrets hashed at rest, OAuth clients bound to their redirect URIs,
  Quasar cookies bound to their account, explicit ownership of proxy
  scenarios; account deletion and logout fixed.

## 2.2.2 (2026-10-21)

- Security fix for hosted mode: requests are served only with the
  authenticated owner's credentials
  ([GHSA-xfcm-34qh-f2qg](https://github.com/mctlhq/mctl-alice/security/advisories/GHSA-xfcm-34qh-f2qg)).
