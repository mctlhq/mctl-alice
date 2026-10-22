# Changelog

Versions follow semantic versioning; tags carry no `v` prefix. Full notes for
every version are on the [Releases page](https://github.com/mctlhq/mctl-alice/releases).

## 2.2.10 (2026-10-22)

- The OAuth consent page names the Yandex account being connected, explains
  each permission in plain language, warns that access covers the whole home
  and summarises retention; QR sign-in starts only on request and explains the
  broader session it grants (#92).
- Reusing a spent authorization code or a rotated refresh token revokes the
  tokens issued from that grant; client metadata fetches have an overall
  deadline; an ambiguous room in the home summary is an error (#96).
- Prometheus metrics on a separate listener (`METRICS_PORT`): HTTP status
  classes, auth failures, rate-limit hits and Yandex upstream outcomes (#93).
- Site: `/setup` guide, tested clients, data export and revocation steps,
  self-hosted fonts, og:image, sitemap, canonical links, HTML 404 for
  browsers and an accessibility pass (#95).
- Tests for code and refresh replay, concurrent refresh, client metadata
  fetch guards, ambiguous names and concurrent users (#94).

## 2.2.9 (2026-10-22)

- `CLIENT_IP_HEADER` keys rate limits by a single-valued header the proxy
  overwrites (`cf-connecting-ip` behind Cloudflare), so anonymous clients
  behind a shared ingress no longer share one budget (#90).

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
