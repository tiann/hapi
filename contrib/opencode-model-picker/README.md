# OpenCode model picker (local tool)

Curates which OpenCode models HAPI exposes. The HAPI CLI discovers the full
`opencode` catalog (hundreds of models across every configured provider) via a
short-lived `opencode acp` probe; this picker writes a local filter file that
trims that catalog to a human selection.

## Pieces

| Piece | Location |
|-------|----------|
| Filter implementation (CLI side, single choke point) | `cli/src/modules/common/opencodeModels.ts` (`loadOpencodeModelFilter` / `applyOpencodeModelFilter`, applied before the 60s cache) |
| Picker page (this directory) | `contrib/opencode-model-picker/server.py` |
| Filter file (personal config, outside the repo) | `~/.config/hapi/opencode-model-filter.json` |

## Filter file format

```json
{
  "version": 1,
  "mode": "allowlist",
  "models": ["cpa/gpt-5.4", "ark/ark-code-latest"],
  "updatedAt": "2026-10-31T00:00:00+00:00"
}
```

- `mode`: `off` (default, no filtering) · `allowlist` (keep only listed ids) · `blocklist` (drop listed ids)
- `models`: exact `provider/model` ids as printed by `opencode models`
- Missing file, invalid JSON, unknown mode, or an empty `models` list all
  degrade to **no filtering** — a half-written config can never hide the whole
  catalog.
- Override the path with `HAPI_OPENCODE_MODEL_FILTER_FILE` (env) when a
  non-default location is needed.

## Run

```bash
python3 contrib/opencode-model-picker/server.py --host 0.0.0.0 --port 8791
```

Open `http://<lan-ip>:8791` (phone or desktop browser), check the models to
keep, pick a mode, save. The picker reads the catalog with `opencode models`
(same source the ACP probe sees) and writes the filter file atomically
(temp file + rename).

The CLI re-reads the file on every probe; results are cached per cwd for 60
seconds, so a saved selection takes effect within a minute — no restart
needed once a build containing the filter is deployed.

## Acceptance boundary

- Implemented: catalog listing with provider grouping/search/select-all,
  allowlist/blocklist/off modes, atomic config writes, degraded-to-off on
  malformed input, unit tests for parse/load/apply/wiring.
- Verified by: `bun run test:cli src/modules/common/opencodeModels.test.ts`
  (17 tests) and `bun run typecheck:cli`.
- Not verified here: end-to-end behavior against a deployed runner binary —
  the live installation is a separate npm package build; changes take effect
  only after that package is updated.
- No authentication: the page reads the local model catalog and writes one
  local file. Bind to a trusted network only (`--host 127.0.0.1` to keep it
  local). No HAPI tokens, credentials or session data are involved.
