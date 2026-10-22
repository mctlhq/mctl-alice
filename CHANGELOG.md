# Changelog

Versions follow semantic versioning; tags carry no `v` prefix. Full notes for
every version are on the [Releases page](https://github.com/mctlhq/mctl-alice/releases).

## 2.2.12 (2026-10-23)

- Runs on Node 24 LTS (base image, CI and `@types/node`) (#107).
- TypeScript 7 for builds; emitted JavaScript is unchanged (#88).
- `/readyz` runs one storage check at a time with a 3 s deadline
  (`readinessTimeoutMs`); a stalled check answers 503 instead of hanging (#108).
- Cancelled upstream calls are counted as `cancelled`, not `timeout`, and
  answer 504; Passport error bodies are always sanitised; Quasar error bodies
  are read only up to 4 KiB (#108).
- Tests never reach the network or write `./data/` (#108).

## 2.2.11 (2026-10-23)

- Telemetry retention runs in every mode, hosted included, and prunes rows of
  all owners in small batches; device history answers with a clear error in
  hosted mode (#98).
- Review follow-ups (#99): a caller's deadline is reported as a cancellation,
  not an upstream timeout; Yandex response bodies are read inside the request
  deadline (504 on a stall); Smart Home API timeouts answer 504; `/account/*`
  has its own rate-limit bucket (`RATE_LIMIT_ACCOUNT`); `/readyz` probes share
  one storage check per second; a metrics listener bind failure no longer
  stops the app and `METRICS_PORT` accepts digits only; public pages answer
  HEAD and stay indexable without a canonical URL; font URLs carry a content
  hash; hosted mode warns at startup when `PUBLIC_BASE_URL` is unset.
- Tests use a private in-memory telemetry database (#105).
- Dependencies: MCP SDK 1.32.1, zod 4.6.7, pg 8.23.1, dotenv 18.0.8,
  hono 4.13.13, ip-address 10.7.4; Vitest 5 for tests; GitHub Actions bumps
  and the reviewer workflow pin (#80-#89, #100-#104).

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
