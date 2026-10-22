# Changelog

Versions follow semantic versioning; tags carry no `v` prefix. Full notes for
every version are on the [Releases page](https://github.com/mctlhq/mctl-alice/releases).

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
