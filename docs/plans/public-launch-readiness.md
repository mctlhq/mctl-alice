# Public launch readiness: audit and implementation plan

Status: audit complete; implementation pending; **not ready for public promotion**.

Reviewed on 2026-09-20 against repository commit `5496ece` and the deployed
`ghcr.io/mctlhq/mctl-alice:1.9.4` image. This is the canonical plan. The findings
below describe the reviewed version, not claims about a future fixed release.

## Agreed product decisions

- Offer a public, multi-user SaaS at `https://alice.mctl.ai`, with each user
  connecting their own Yandex account. Preserve a separately configured
  self-hosted/local mode.
- Keep Quasar speech and arbitrary text commands in SaaS, behind a separate,
  explicit opt-in explaining that a Yandex web session is broader than an
  IoT-scoped OAuth token. Do not label this integration as an official,
  narrowly scoped OAuth integration.
- Access covers the whole connected home. Explain reading, device control,
  scenarios, and Quasar separately. Do not promise device-level isolation:
  arbitrary commands and scenarios can affect other devices in the home.
- Home history is disabled by default. Users may enable minute-by-minute
  sampling with 30-day retention and controls to stop collection and erase it.
- Present this as a personal open-source project. The owner confirmed the
  public details: Dmitry Mashkov, Montenegro; `mashkovd@live.ru` for support
  and privacy requests; `security@mctl.ai` for confidential security reports.
- Repository documentation remains English; the public UI supports Russian
  and English. Preserve the existing visual identity rather than redesigning
  the product before fixing its trust and authorization model.

## Evidence and boundaries

Reviewed the tracked application, authentication, clients, storage, tools,
tests, Dockerfile, README, and static assets; inspected GitHub metadata,
community files, workflow inventory, and branch protection through its API.
The local HEAD matched the remote HEAD during the review.

Visited the landing page in both languages and checked desktop and a
390-pixel mobile viewport. Visually checked the callback error, Quasar page,
QR generation, manual-cookie instructions, and MCP consent screen. The consent
probe requested only `iot:view`; no approval was submitted. No Yandex account
was connected and no real home/device commands were executed. QR creation
worked; completing QR authorization was not tested.

Inspected public HTTP responses, OAuth metadata, and live Kubernetes deployment
metadata. The platform MCP connector required reauthentication, so deployment
inspection used the existing kubeconfig read-only. No secret values or user
database contents were needed. Storage-provider encryption, backup policies,
upstream Yandex consent branding, existing user impact, and incident history
were not independently verified.

Validation:

- `npm test`: **126 tests passed**, across 11 files.
- `npm run typecheck`: passed.
- Local in-memory probe with fake credentials: an MCP token was issued without
  a Yandex login or PKCE, accepted despite a different client ID and omitted
  redirect URI, and resolved the process-wide Yandex token and Quasar client.
  No network calls to home APIs were made in this probe.
- `npm audit --omit=dev`: no reported production dependency vulnerabilities.
- Full `npm audit`: two moderate package findings (`vitest` and
  `@vitest/mocker`) for the same
  [advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
  These are development dependencies; this is not evidence of a production
  exploit. The current tests do not establish safe multi-user isolation.

### Public page and endpoint inventory

| Surface | Observed behavior | Required improvement |
| --- | --- | --- |
| `/` | 200; coherent styling, RU/EN, theme control, capabilities and setup | Explain value and access before login; demo, operator, pricing/beta terms, support, privacy, revocation, accurate feature matrix |
| `/auth/login` | 302 to Yandex using `response_type=token`; redirect has no state | Use the owned SaaS OAuth application, authorization-code flow, browser-bound state and a user-specific connection |
| `/auth/callback` | 200; missing-token error under a success heading/title | Distinct success, denied, expired, missing-state, and failure screens with useful recovery |
| `/auth/cookie` | 200; QR initializes automatically; manual Session_id form | Require authenticated user and explicit advanced-access consent before QR creation or cookie submission |
| `/oauth/authorize` | Consent renders without login; read-only request shows both scopes and says the home is connected | Show verified account, exact granted scopes, unambiguous client identity, recipients and revocation; never invent connection status |
| `/oauth/yandex/callback` and OAuth action/error branches | Inspected in code and existing tests, not completed against a real account | Validate state/session ownership; escape errors; test success and failure using dedicated staging accounts |
| `/mcp` | Anonymous GET returns 401 and discovery challenge | Preserve that gate; enforce user ownership and permissions on every transport and tool |
| `/api/info`, `/openapi.json`, discovery documents | 200 | Synchronize versions and advertised behavior; replace health endpoint as resource documentation |
| `/healthz`, `/readyz` | 200, both always report OK and version 1.8.0 | Distinguish readiness from liveness and report actual build version |
| `/robots.txt` | Allows all paths | Keep auth/account pages out of indexing and include sitemap location |
| `/privacy`, `/terms`, `/security`, `/sitemap.xml` | 404 | Add public pages and sitemap; use a helpful HTML 404 for browser navigation |

The reviewed HTML responses lacked CSP, frame protection, Referrer-Policy,
X-Content-Type-Options and HSTS. Wildcard CORS was present. These are observed
response properties, not a claim that wildcard CORS alone permits theft of
authenticated data. Google Fonts is loaded externally and must either be
disclosed or replaced with locally hosted fonts.

### Security findings

**S1 — Critical: user identity is not an enforced authorization boundary.**
`src/auth/oauth-controller.ts:290` and `:310` allow code issuance without a
verified Yandex user. `src/server/http-server.ts:272` and `:303` can resolve
the global Quasar client and environment token for that grant. A token-shaped
Yandex string is also accepted before upstream validation (`:324`), with the
same shared Quasar fallback. The fake-credential probe confirmed the local
chain; production device access was deliberately not attempted.

**S2 — Critical: onboarding mutates service-wide credentials.**
The callback, save-token, save-cookie, and successful QR-status paths replace
shared service objects and/or write credentials into process state and `.env`
(`src/server/http-server.ts:1275`, `:1406`, `:1642`, `:1709`). They are not bound
to a logged-in SaaS user. Concurrent customers cannot safely use this model.
The QR-status response also serializes a result that includes the Yandex
cookie (`:1683`); the browser needs connection status, not that secret.

**S3 — High: OAuth safeguards are incomplete.**
PKCE is optional, token exchange does not enforce client identity, redirect
matching is permissive, scopes are not enforced by tool dispatch, and consent
can be approved through GET or request-controlled auto-approval. Registration
accepts a caller-supplied client ID with replacement semantics. Remote client
metadata fetching has no private-address/redirect defenses. These issues need
negative tests, not just successful login tests.

**S4 — High: secrets and session lifecycle are insufficiently protected.**
`src/storage/oauth-storage.ts` stores upstream and downstream secrets directly
in SQLite TEXT fields; `src/auth/token-storage.ts` writes plaintext `.env`
values. At-rest encryption is not implemented at the application layer, despite
the website promise. HTTP query strings and OAuth redirect URLs are logged,
including authorization codes and session identifiers. SSE messages rely on
the transport session ID without rechecking the owning grant; revocation does
not establish immediate termination of existing transports. Request bodies,
registration volume and QR creation lack application-level bounds.

**S5 — High: home history lacks a user boundary and meaningful consent.**
The default sampler runs every 60 seconds with 30-day retention against the
shared service. Stored rows include device ID/name, room, metric, timestamp
and value, without a user ID. `getDeviceHistory` does resolve the requested
device against the service first, so missing database ownership alone is not
proof of an independently exploitable history IDOR. The shared service model
and absent opt-in still block the multi-user launch.

**S6 — High: persistence is absent in the deployed workload.**
The live `labs-mctl-alice-base-service` deployment has one replica, no volumes
or mounts, and RollingUpdate. Default SQLite files and newly saved `.env`
credentials are container-local and do not survive container replacement.
The container has no explicit security context and the Dockerfile has no
non-root USER. Existing secret injection is present, but its contents were
not read. A readiness response of OK does not verify durable storage.

**S7 — Additional hardening.**
Escape device names inserted by callback JavaScript using text nodes rather
than `innerHTML`; escape all upstream errors. Replace interpolated shell
commands in the macOS Keychain helper with argument-based `execFile` calls.
Review the source-embedded OAuth client secret and remove reliance on borrowed
application credentials; establish ownership before deciding any rotation.
Audit git history without printing discovered secret values.

**S8 — High: Quasar proxy scenarios are mutable shared resources.**
`src/client/quasar-client.ts:314` may adopt any existing `mctl-` scenario for
a different speaker. Speech and commands update that scenario and then trigger
it in separate requests, without serialization. Concurrent calls can overwrite
the intended target or text. The text is written into a scenario at Yandex and
is not cleared/deleted afterwards by this client; privacy copy must not imply
that it is only transiently transmitted. This is a code finding; no real
scenario was created or modified during the review.

### Product, documentation and GitHub findings

- The visual foundation is usable: consistent typography, restrained colors,
  feature cards, two languages and responsive stacking. The first screen is
  technical and text-heavy; it offers an endpoint and login before explaining
  who receives access, who runs the service, or how to disconnect. Mobile
  navigation wraps the brand and gives Quasar jargon prominent space.
- The safety FAQ asserts encrypted tokens and exclusively official APIs.
  The reviewed implementation does not support those statements. Do not
  substitute reassuring wording for the required engineering changes.
- The landing page and README enumerate six tools, while the implementation
  exposes twelve, including whole-room control, arbitrary device control,
  home summaries and history. Consent must cover the actual capability set.
- README starts with obtaining and copying an upstream Yandex token and covers
  local Node configuration, not the advertised hosted onboarding. It lacks
  screenshots/demo, a security/data-flow explanation, disconnection, privacy,
  verified compatibility, beta/support expectations and deployment guidance.
  Remove the suggestion to reuse a token from another integration.
- GitHub description, homepage and topics are empty. GitHub does not recognize
  a license file although package metadata/README say Apache-2.0. No LICENSE,
  SECURITY, CONTRIBUTING or issue/PR templates are tracked. Community health
  was 25%; this is a packaging signal, not a security score.
- GitHub API returned zero workflows, no rulesets and unprotected `main`.
  Dependabot security updates, secret scanning and push protection were
  disabled. Semver tags exist; no GitHub releases were listed.
- Versions disagree: package/image 1.9.4, MCP/health 1.8.0, OpenAPI 1.0.0 and
  static cache parameters 1.9.2/1.9.4. OpenAPI YAML URL returns JSON. There is
  no social preview image or sitemap.

## Implementation sequence and release gates

### 1. Establish safe hosted identity and storage

- Before bringing in users, disable new production grants and credential
  writes until isolation is fixed. Keep an informative public landing page.
  Treat possible past exposure as an investigation: review redacted access
  evidence and affected time windows, then revoke/rotate affected grants and
  credentials as warranted. Do not claim a breach occurred without evidence.
- Separate hosted HTTP from local/self-hosted operation explicitly. Hosted
  mode always requires authentication and must never fall back to environment
  or Keychain home credentials. Keep local credential convenience only in the
  local mode. Missing user credentials produce a reconnect error.
- Introduce a stable user identity, browser sessions, Yandex connections and
  per-client grants. Use an owned Yandex OAuth application; retrieve and verify
  a stable provider user ID server-side rather than trusting a name, device
  list, client ID, submitted user ID or possession of a session URL.
- Bind pending OAuth transactions, authorization codes, refresh families,
  Quasar sessions, caches and telemetry to that user. Supply request-scoped
  clients with explicit credentials; no singleton user credentials or implicit
  constructor fallbacks in hosted code. Verify Quasar and IoT identities match
  before attaching both to one account; reject mismatches.
- Retain SQLite for the first one-replica release, on a persistent volume with
  Recreate deployment strategy. Back up a consistent database snapshot rather
  than copying a live file. Establish and test restoration before opening
  registration; horizontal scaling is outside this release.
- Encrypt upstream OAuth/refresh tokens and Quasar cookies using authenticated
  encryption (AES-256-GCM, random nonce, key ID, owner-bound associated data),
  with keys supplied separately through the platform secret store. Store only
  hashes of opaque MCP tokens and browser session tokens. Use a non-root
  container, restrictive data permissions and a read-only application layer.
- Do not assign old unowned rows to a guessed user. Invalidate legacy grants,
  require reconnection, and remove unowned credentials/history under an
  explicit migration procedure. Never restore the shared-account behavior as
  a rollback strategy.

Gate: two independently authenticated test users remain isolated through
login, refresh, simultaneous requests, Quasar use, history and restarts.

### 2. Make authorization enforce what the user approves

- Use authorization-code flow with one-use, browser-bound state and required
  S256 PKCE for public MCP clients. Validate client identity, registered
  redirect URI, resource/audience and scopes at issuance and use. Apply exact
  redirect matching with the documented native-loopback port exception.
- Remove request-controlled auto-approval and GET approval. Consent requires
  authenticated POST with CSRF/Origin validation. `prompt=none` cannot create
  a new grant without an existing authenticated and consented relationship.
- Issue server-generated registration IDs; prevent overwrites and client-name
  impersonation. Fetch client metadata only through bounded HTTPS requests
  with DNS/IP and redirect validation against private, loopback, link-local
  and metadata addresses; validate document identity and redirect metadata.
- Accept only this server's MCP access tokens on hosted MCP/REST endpoints.
  Do not accept upstream Yandex bearer tokens or a cookie header as SaaS
  authentication. Bind SSE transport ownership and recheck grant validity on
  every message; revocation must disable active transports and refresh families.
- Keep `iot:view` and `iot:control` as distinct enforceable permissions. Add
  an explicit service-specific Quasar permission for advanced commands. A
  granted scope cannot exceed the user's consent or upstream capability.
  Filter advertised tools where appropriate and always enforce at dispatch.
- Protect browser sessions with Secure, HttpOnly, SameSite cookies; add
  request size limits, endpoint-specific rate limits, upstream timeouts,
  session expiry, safe CORS and security headers. Use nonce/hash-based CSP,
  frame-ancestors protection, no-referrer and no-store on authentication pages.
- Log route templates and redacted outcomes, not codes, cookies, tokens,
  raw query strings or full upstream responses. Document log retention and
  include secret-redaction tests. Fix callback HTML injection and shell
  interpolation throughout the affected helpers.
- Track only service-created proxy scenarios by user and speaker; never adopt
  an arbitrary similarly named scenario. Serialize update-and-trigger work for
  each proxy, preserve ownership across reconnects, and expose cleanup of
  service-created scenarios on disconnection. Reject ambiguous device/room
  targeting instead of silently choosing a different device for writes.

Gate: auth bypass, cross-user requests, wrong scopes, wrong client/audience,
replayed codes/refresh tokens, revoked sessions, unsafe metadata URLs, forged
browser requests and oversized bodies are rejected by integration tests.

### 3. Build understandable connection and disconnection

- Make the main CTA “Connect your assistant” and show client-specific steps;
  keep the MCP URL as a secondary copy action. Show a short recorded demo
  without private home data. Publish only tested client/version combinations.
- Before Yandex login, show the operator and a compact data-flow explanation:
  the AI client sends tool arguments to mctl-alice; mctl-alice sends applicable
  requests to Yandex and returns tool results to the AI client. Explain that
  device/room names, states and requested history may reach the AI provider.
  Do not claim access to the entire chat or microphone recordings.
- On MCP consent show the verified account, requesting client and domain,
  actual selected permissions, whole-home implications, retention, links to
  privacy/security, and equally understandable cancel and allow actions.
- Keep `/auth/cookie` as an authenticated advanced-connection page. Explain
  before starting QR: this creates/shares a Yandex web session whose potential
  access is broader than smart-home OAuth. Avoid “only your speakers” claims.
  Require an unchecked opt-in; QR is a convenience after that decision.
- Bind QR creation and polling to the logged-in browser session; return only
  waiting/connected/expired/failed status. Never return the acquired cookie.
  Give clear recovery for expiry, account mismatch and upstream failure.
- Add an account page showing connection status, connected AI clients and
  permissions. Allow per-client revoke, Quasar disconnect, stop/delete
  history, export own stored data, and full account-data deletion with explicit
  confirmation. Explain that deleting a local credential differs from revoking
  an upstream Yandex session, and provide the correct upstream instructions.
- Default history to off. Enabling it records explicit consent and starts
  only that user's sampler. Store and query with user ownership; prune on
  startup and periodically. Disabling stops sampling; deleting clears history.
  Whole-account deletion stops jobs and revokes access before removing data.
- Use real error states on callbacks and preserve navigation back to the
  assistant. Replace technical success messages about a “permanent refresh
  token” with the account connected, permissions granted and next step.

Gate: a first-time user can explain what the service and AI client receive,
what commands can do, what Quasar changes, and how to stop access before
approving. Declining Quasar still leaves the documented IoT features usable.

### 4. Complete public documentation and repository presentation

- Add `/about`, `/privacy`, `/terms`, `/security`, `/setup` and `/account` with
  consistent navigation and RU/EN content. Publish the confirmed operator
  contacts, beta availability/price, support limits and independent-project
  status. Do not imply affiliation or certification by Yandex or AI vendors.
- Publish a factual data inventory: identities, credentials, device metadata,
  command arguments/results, optional history, technical logs, recipients,
  purposes, retention, operator access and deletion. Name infrastructure
  processors and storage region only after verifying them. Verify the mailbox,
  retention and backup facts; do not invent compliance certifications or SLAs.
- Explain that Quasar writes phrase/command text into Yandex proxy scenarios;
  distinguish local data deletion, removal of service-created scenarios and
  Yandex's own retention. Do not claim control over upstream retention.
- Self-host fonts to remove the third-party font request. Add social preview
  artwork, sitemap, canonical URLs, noindex for auth/account pages, a human
  404, accessible focus/status announcements and mobile navigation that fits.
- Rewrite README around the hosted product: short value proposition, demo,
  tested quickstart, all twelve tools grouped by read/control/advanced access,
  data-flow/security/revocation, limitations, self-hosting, development and
  support. Distinguish supported functions by IoT versus Quasar requirements.
- Keep one version source for package/build/API/docs. Complete `.env.example`
  for separate hosted and local modes with no real secrets. Document minimum
  Node version, build-before-run, durable storage and owned OAuth app setup.
- Add the Apache-2.0 license text, SECURITY reporting policy, contribution
  guide, changelog/release notes and issue/PR templates. Never ask users to
  include tokens, cookies or unredacted home data in public bug reports.
- Set repository description, homepage and topics; enable secret scanning,
  push protection, dependency alerts/updates and confidential reporting where
  supported. Add CI for tests, typecheck, build, dependency/secret scanning and
  the workspace-required review workflow; protect `main` with required checks.

Gate: fresh users can connect from README without copying upstream secrets;
site, actual tools and documented permissions agree; all public links work.

### 5. Validate and stage the public release

- Expand the existing suite with two-user fixtures, permission matrices,
  browser-bound consent, QR ownership/redaction, token expiry/reuse/revocation,
  refresh concurrency, metadata SSRF, history opt-in/deletion and persistence
  restore tests. Replace tests that currently assert unauthenticated issuance.
- Include concurrent TTS/command calls on two speakers, proxy ownership and
  cleanup failures, duplicate device names and ambiguous room targeting.
- Exercise RU/EN and both themes at 360, 390, 768 and 1440 pixels; keyboard
  navigation; pending/denied/expired/revoked/offline states; and no-device
  accounts. Verify page headings, labels, error recovery and no overflow.
- In staging use dedicated Yandex accounts to complete actual OAuth and QR
  flows, verify account matching, and test read/control actions on designated
  devices. Test the exact supported versions of each promoted AI client.
  A tools/list response alone is not an end-to-end compatibility result.
- Validate persistent state across container replacement, restore a backup,
  and monitor authentication failures, rejected authorization, upstream errors,
  storage health and latency without collecting secrets or command content.
- Treat the hosted authentication change as breaking; target `2.0.0` with
  reconnection instructions. Use a feature branch, PR, required CI/review and
  merge commit; tags have no `v` prefix and commits have no co-author trailers.
- Launch first to a small invited cohort, observe real onboarding and
  disconnect flows, then publish the demo and promotion. Public promotion is
  gated on all critical/high findings being resolved and verified, durable
  storage working, truthful trust pages, and successful two-user end-to-end
  checks. An emergency rollback keeps registration closed rather than
  restoring the unsafe shared-credential implementation.

## Source references

- [Public service](https://alice.mctl.ai/) and
  [repository](https://github.com/mctlhq/mctl-alice).
- [Yandex smart-home API permissions](https://yandex.ru/dev/dialogs/smart-home/doc/ru/concepts/platform-protocol).
- [Yandex OAuth application registration and revocation](https://www.yandex.com/dev/id/doc/en/register-client).
- [MCP authorization requirements](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/basic/authorization.mdx).
  Recheck the applicable current specification during implementation rather
  than treating this reviewed revision as the newest protocol version.

## Progress

- [x] Review site, repository, authorization/storage code and deployment metadata.
- [x] Reproduce the authorization boundary failure locally with fake data.
- [x] Record owner decisions and baseline verification.
- [ ] Contain unsafe public onboarding and investigate potential existing impact.
- [ ] Implement and verify isolated hosted identity, storage and permissions.
- [ ] Deliver consent, account controls and optional Quasar/history flows.
- [ ] Complete public documentation, README, GitHub metadata and CI protections.
- [ ] Pass staging and invited-user acceptance checks before promotion.
