# Tool surface and the Personal Assistant pin

Two committed files describe the tools this server offers. Both are checked
by `npm test`, so CI fails a pull request that changes a tool without
updating them.

| File | What it is | Checked by |
| --- | --- | --- |
| `docs/tool-descriptors.json` | Every registered tool as `tools/list` returns it (name, description, `inputSchema`, annotations) plus the OAuth scopes that admit a call. Generated. | `tests/tool-descriptors.test.ts` |
| `docs/pa-pinned-tools.json` | The tools the Personal Assistant pins, with the fields it compares. Updated on purpose. | `tests/pa-pinned-tools.test.ts` |

## Why the second file exists

The Personal Assistant (PA) in `mctlhq/mctl-telegram` holds the `iot:view`
scope and pins this server's read tools in `internal/pa/catalog/pin.json`.
The pin is built from a snapshot of this server's `tools/list`,
`internal/pa/catalog/testdata/alice.tools.json`. At run time the PA compares
each live tool with its pin and denies a tool whose description, input schema
or annotations differ, or which is missing. The denial is deliberate: a tool
that changed after it was reviewed is not offered to the model.

The cost is on this side. Rewording a description here is enough to take a
tool away from the PA until someone refreshes the pin, and the PA only finds
out in production. `docs/pa-pinned-tools.json` makes that visible in the pull
request that causes it.

## What is compared

For each tool in `docs/pa-pinned-tools.json`, in the same canonical form as
`mctl-telegram` (`internal/pa/catalog/canonical.go`, `listing.go`):

| Field here | Field in `pin.json` (`servers.alice.tools.<name>`) | Meaning |
| --- | --- | --- |
| `description_sha256` | `description_sha256` | hex SHA-256 of the UTF-8 description |
| `input_schema_sha256` | `input_schema_sha256` | hex SHA-256 of the input schema as canonical JSON: keys sorted, no whitespace |
| `annotations` | `annotations` | the annotations object; key order does not matter |

`description` and `input_schema` are the readable source of the two hashes;
the test refuses a file where they disagree. The same test also fails when a
pinned tool is no longer registered or no longer accepts `required_scope`
(`iot:view`).

To compare the two repositories by hand:

```sh
jq -S '.tools | map_values({description_sha256, input_schema_sha256, annotations})' docs/pa-pinned-tools.json
jq -S '.servers.alice.tools | map_values({description_sha256, input_schema_sha256, annotations})' ../mctl-telegram/internal/pa/catalog/pin.json
```

The two outputs must be identical.

Until mctlhq/mctl-telegram#1439 is merged they differ on `annotations`: the
pin on `main` there was taken before this server annotated its tools and
still holds `{}`, so the PA denies all four tools. This file already holds
the values of the refreshed pin in that pull request. Remove this paragraph
once it is merged.

## A tool changed and `tool-descriptors.test.ts` fails

```sh
npm run update:tool-descriptors
```

Commit the regenerated `docs/tool-descriptors.json`. The diff is the surface
change a reviewer should read.

## A pinned tool changed and `pa-pinned-tools.test.ts` fails

The failure names the tool and the field. Decide first whether the change is
needed: reverting it is the cheapest fix. If it is needed:

1. Regenerate the descriptor here: `npm run update:tool-descriptors`.
2. In `mctlhq/mctl-telegram`, replace
   `internal/pa/catalog/testdata/alice.tools.json` with the new
   `docs/tool-descriptors.json` (the extra `scopes`, `schema` and `$comment`
   keys are ignored there) and refresh the pin:

   ```sh
   go test ./internal/pa/catalog -run TestPinMatchesUpstream -update-pin
   ```

   The command rewrites `pin.json` and `pin_phase2.json`, both derived from
   that snapshot. Open that pull request.
3. In the pull request here, acknowledge the change:

   ```sh
   npm run update:pa-pin
   ```

   Commit `docs/pa-pinned-tools.json` and link the `mctl-telegram` pull
   request in the description.
4. Order the releases so the PA is not left without the tool: between the
   release of this server and the release of the refreshed pin the PA denies
   the changed tool. Merge and release the two close together, or accept the
   gap knowingly.

`npm run update:pa-pin` rewrites only the compared fields of tools that are
already pinned. It does not add or remove a pinned tool. To pin another tool
or stop pinning one, edit the `tools` object of the file and the name list in
`tests/pa-pinned-tools.test.ts` together, after the pin in `mctl-telegram`
has changed the same way.

## What this does not check

The test compares this repository with its own copy of the pin. It cannot
read `mctl-telegram`, so it does not prove that `pin.json` there holds the
same values; the `jq` comparison above does. It also says nothing about what
is deployed.
