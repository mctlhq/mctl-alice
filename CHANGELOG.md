# Changelog

Versions follow semantic versioning; tags carry no `v` prefix. Full notes for
every version are on the [Releases page](https://github.com/mctlhq/mctl-alice/releases).

## 2.4.0 (2026-11-01)

- New gauge `mctl_alice_sse_streams_open` (legacy SSE streams currently open),
  read at scrape time so a missed close cannot make it drift (#129).
- Calls answered 429, or redirected to a captcha page, now count under a new
  `blocked` upstream outcome, so Yandex throttling an egress IP can be told
  apart from Yandex being down (#134).
- `getUserInfo` shares one 15 s budget between the Yandex IoT call and the
  Quasar fallback; a hung IoT call no longer adds a further 10 s (#135).
- `/readyz` checks storage with `SELECT 1` instead of a statistics scan
  (#128), and a tool call re-checks the user's credentials at most once per
  second instead of twice, cutting database reads from 6 to 3 (#130).

## 2.3.0 (2026-11-01)

- A failed or timed-out call to Yandex now writes one `[upstream-failure]`
  log line with the upstream, outcome, elapsed time, error class, the network
  cause code (for example `ECONNRESET`) and an 8-hex tag of the user, so
  `MctlAliceUpstreamErrorRatioHigh` can be traced to a cause and to a user
  count. Messages, URLs, headers and bodies are never logged (#126).
- The landing page targets a quick-win search query and carries FAQ and
  breadcrumb structured data (#125); ecosystem services are cross-linked and
  the application schema is added (#124).

## 2.2.15 (2026-10-31)

- The landing and account pages take their design tokens from
  `@mctlhq/css` 0.19.0 (was 0.5.0); `scripts/sync-tokens.mjs` now lives in
  this repository (`npm run sync:tokens` / `check:tokens`). No visual change
  (#122).
- Dependency updates: `@hono/node-server` 2.1.5, `@modelcontextprotocol/sdk`
  1.32.2, `dotenv` 18.0.9, `body-parser` 2.4.0, `fast-uri` 3.1.9
  (#113, #114, #118, #119, #121).

## 2.2.14 (2026-10-25)

- An owner's Quasar proxy scenario keeps its own voice trigger on every
  update, so speech and text commands no longer fail with "the activation
  phrase is already in use" next to a proxy created before ownership was
  recorded (#115).

## 2.2.13 (2026-10-25)

- Quasar reads its CSRF token from `yandex.ru/iot/`: since 2026-10-23
  `yandex.ru/quasar` resets every connection, which broke speech, text
  commands and scenarios through the web session. The cookie setup guide
  links the working page (#111).

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
