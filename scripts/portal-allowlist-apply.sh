#!/usr/bin/env bash
# Apply docs/portal-allowlist.json to the Cloudflare MCP portal mapping.
#
# The portal hides only what it has an explicit entry for, so this file is
# re-applied on every change to the server's tool set (the guard test in
# tests/portal-allowlist.test.ts refuses to let the set change without a
# decision here). Operator-run: CI holds no Cloudflare credential (#1111).
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/portal-allowlist-apply.sh [--dry-run|--check|-h|--help]
#
# Run it from a checkout with npm dependencies installed (`npm ci`): the file
# is only applied (or checked) when it matches HEAD and the guard test
# passes for it. Ported from mctlhq/mctl-api's script of the same name, with
# the Go guard swapped for this repository's vitest one.
#
# What is sent: the portal body exactly as read, minus the four top-level
# timestamps (created_at, created_by, modified_at, modified_by), with only
# the target server's mapping rewritten. Nested read-only fields on the
# server elements go back out as they came. The per-tool entries are the
# exception, on purpose: updated_tools is rewritten as exactly {name,
# enabled} from the file, which is the source of truth for the whole
# per-tool record.
#
# --check compares the committed file against the live portal mapping
# instead of writing to it, under the same pre-flight guards as an apply or
# a --dry-run (credentials, jq, git checkout, tracked-and-matches-HEAD,
# portal=mcp/server=alice, node, the guard test) and never issues a PUT.
#
# The token is never a curl argument: curl reads it from a config written by
# a builtin over a file descriptor, so it does not appear in the process
# table. It still lives in this process's environment; feed it from a
# secret store rather than typing it on the command line.
#
# Exit codes: 0 in sync / applied, 1 could not check or apply (a pre-flight
# guard refused, or an API call failed), 2 usage error, 3 drift found
# (--check only).
set -euo pipefail

usage() {
  cat <<EOF
usage: $0 [--dry-run|--check|-h|--help]

  (no argument)  apply docs/portal-allowlist.json to the Cloudflare portal
                 mapping. Exit 0 on success, 1 on any pre-flight or API
                 failure.
  --dry-run      print the body that would be PUT; never writes. Same exit
                 codes as the default apply.
  --check        compare the committed file against the live portal
                 mapping; never writes. Exit 0 when they agree, 1 when the
                 comparison could not be made (pre-flight or API failure),
                 3 when they disagree.
  -h, --help     print this usage and exit 0.

Exit codes: 0 in sync / applied, 1 could not check or apply, 2 usage error,
3 drift found (--check only).
EOF
}

mode=apply
case "${1:-}" in
  "")          mode=apply ;;
  --dry-run)   mode=dry-run ;;
  --check)     mode=check ;;
  -h|--help)   usage; exit 0 ;;
  *) usage >&2; echo "unknown argument: $1" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { usage >&2; echo "usage error: $0 takes at most one argument" >&2; exit 2; }

here=$(cd "$(dirname "$0")/.." && pwd)
file="$here/docs/portal-allowlist.json"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

# The invariant -- an enabled tool carries a reason, and a mutating one is
# additionally named in mutatingOnPortal -- lives in the vitest guard,
# because the tool set it checks against is TypeScript source. This path
# publishes what is on disk, so it consults the same test first, and it
# refuses a file that differs from HEAD (staged or not: `diff HEAD` sees
# both), so what is applied is always a committed, reviewable revision.
git -C "$here" rev-parse --git-dir >/dev/null 2>&1 \
  || { echo "$here is not a git checkout, so the file cannot be compared against the committed one; run this from a clone" >&2; exit 1; }
git -C "$here" ls-files --error-unmatch -- docs/portal-allowlist.json >/dev/null 2>&1 \
  || { echo "docs/portal-allowlist.json is not tracked in $here; what is applied must be the committed file" >&2; exit 1; }
if ! git -C "$here" diff --quiet HEAD -- docs/portal-allowlist.json; then
  echo "docs/portal-allowlist.json differs from HEAD (staged or unstaged); commit it before applying" >&2; exit 1
fi
# What is applied is the committed blob, not the copy on disk: the guard
# test runs code from the checkout and could in principle rewrite the file
# on disk between the check and the build, so the PUT is built from the
# blob, never from a re-read of the path.
vetted=$(git -C "$here" show HEAD:docs/portal-allowlist.json)
portal=$(jq -r .portal <<<"$vetted"); server=$(jq -r .server <<<"$vetted")
[ "$portal" = mcp ] && [ "$server" = alice ] || { echo "$file targets portal=$portal server=$server; expected mcp/alice" >&2; exit 1; }
if command -v npx >/dev/null; then
  if ! guard_out=$(cd "$here" && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx vitest run tests/portal-allowlist.test.ts 2>&1); then
    echo "the guard test did not pass for the current file; refusing to apply" >&2
    printf '%s\n' "$guard_out" >&2
    exit 1
  fi
else
  echo "node/npx is not installed here, so the guard test cannot run; refusing to apply from a host that cannot verify the file" >&2; exit 1
fi

base="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/ai-controls/mcp"
cf() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$CLOUDFLARE_API_TOKEN") "$@"; }
must_succeed() {
  local body; body=$(cat)
  if ! jq -e .success >/dev/null 2>&1 <<<"$body"; then
    echo "$1 failed: $(jq -c '.errors // .' 2>/dev/null <<<"$body" || echo "$body")" >&2; exit 1
  fi
  printf '%s' "$body"
}

current=$(cf "$base/portals/$portal" | must_succeed "read portal")
server_body=$(cf "$base/servers/$server" | must_succeed "read server")

mapped=$(jq --arg s "$server" '[.result.servers // [] | .[] | select(.server_id == $s)] | length' <<<"$current")
[ "$mapped" = 1 ] || { echo "portal '$portal' has $mapped mapping(s) for server '$server'; expected exactly one" >&2; exit 1; }

synced=$(jq -r '.result.tools // [] | .[].name' <<<"$server_body" | LC_ALL=C sort)
[ -n "$synced" ] || { echo "server '$server': the API returned no synced tools (result.tools is missing or empty); has it connected?" >&2; exit 1; }
listed=$(jq -r '.tools[].name' <<<"$vetted" | LC_ALL=C sort)
uncovered=$(LC_ALL=C comm -23 <(echo "$synced") <(echo "$listed"))
uncovered_drift=""
if [ -n "$uncovered" ]; then
  if [ "$mode" = check ]; then
    uncovered_drift=$(while IFS= read -r t; do
      printf 'drift: %s synced by the server with no decision in docs/portal-allowlist.json\n' "$t"
    done <<<"$uncovered")
  else
    echo "synced tools with no decision in $file:" >&2
    echo "$uncovered" >&2
    echo "if a recent release removed these tools, the portal has not re-synced yet: wait and re-run. Do not add them back to the file -- the guard test rejects entries for tools the server no longer registers." >&2
    exit 1
  fi
fi

body=$(jq --arg s "$server" --argjson a "$vetted" --rawfile synced_raw <(echo "$synced") '
  ($synced_raw | split("\n") | map(select(. != ""))) as $synced
  | .result
  | del(.created_at, .created_by, .modified_at, .modified_by)
  | .servers |= map(
      if .server_id == $s then
        .default_disabled = $a.default_disabled
        | .updated_tools = [ $a.tools[] | select(.name as $n | $synced | index($n) != null)
                             | {name, enabled: (.enabled // false)} ]
      else . end)' <<<"$current")

if [ "$mode" = check ]; then
  expected=$(jq -c --arg s "$server" '[.servers[] | select(.server_id==$s)][0]' <<<"$body")
  actual=$(jq -c --arg s "$server" '[.result.servers // [] | .[] | select(.server_id==$s)][0]' <<<"$current")

  tool_drift=$(jq -r -n --argjson expected "$expected" --argjson actual "$actual" '
    def dtools(side): if (side|has("updated_tools")) and side.updated_tools != null then side.updated_tools else [] end;
    def sentinel(side; name):
      (dtools(side) | map(select(.name == name)) | first) as $e
      | if ($e != null and ($e|has("enabled"))) then $e.enabled else "absent" end;
    (if $expected.default_disabled == $actual.default_disabled then empty
     else "drift: default_disabled portal=\($actual.default_disabled) file=\($expected.default_disabled)" end),
    (((dtools($expected) | map(.name)) + (dtools($actual) | map(.name)) | unique) as $names
      | $names[] as $n
      | sentinel($actual; $n) as $p
      | sentinel($expected; $n) as $f
      | select($p != $f)
      | "drift: \($n) portal=\($p) file=\($f)")
  ')

  total_drift=$(
    { printf '%s\n' "$uncovered_drift"
      printf '%s\n' "$tool_drift"; } | sed '/^$/d'
  )
  if [ -n "$total_drift" ]; then
    printf '%s\n' "$total_drift"
    n=$(wc -l <<<"$total_drift" | tr -d ' ')
    echo "$n difference(s) between the portal and docs/portal-allowlist.json" >&2
    exit 3
  fi

  held_back=$(LC_ALL=C comm -23 <(echo "$listed") <(echo "$synced"))

  jq -er -n --argjson want "$expected" '
    $want | select(. != null)
    | "in sync: default_disabled=\(.default_disabled) tools=\(.updated_tools|length) enabled=\([.updated_tools[]|select(.enabled)|.name]|join(","))"' \
    || { echo "check produced no result for '$server'; verify the portal by hand" >&2; exit 1; }
  if [ -n "$held_back" ]; then
    echo "held back (not synced by the server): $(echo "$held_back" | paste -sd, -)"
  fi
  exit 0
fi

if [ "$mode" = dry-run ]; then jq . <<<"$body"; exit 0; fi
sent=$(jq -c --arg s "$server" '[.servers[] | select(.server_id==$s)][0].updated_tools | map({name, enabled}) | sort_by(.name)' <<<"$body")
res=$(cf -X PUT "$base/portals/$portal" --data "$body" | must_succeed "update portal")
jq -er --arg s "$server" --argjson sent "$sent" '[.result.servers // [] | .[] | select(.server_id==$s)] | first | select(. != null)
  | select((.updated_tools | map({name, enabled}) | sort_by(.name)) == $sent)
  | "applied: default_disabled=\(.default_disabled) tools=\(.updated_tools|length) enabled=\([.updated_tools[]|select(.enabled)|.name]|join(","))"' <<<"$res" \
  || { echo "update returned success but the response's updated_tools for '$server' are not the decisions sent (missing mapping, dropped, flipped or extra entries); verify the portal by hand" >&2; exit 1; }
