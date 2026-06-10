# Cursor ACP-verify audit (pre-PR gate)

**Run:** 2026-06-08, machine `f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026`
**Worktree:** `~/coding/hapi/worktrees/cursor-import-acp` @ `1f92a31b` (off `upstream/main`)
**Tool:** `scripts/audit-cursor-acp-verify.ts` (committed in branch `cursor-import-to-hapi`)
**Agent binary:** `/home/heavygee/.local/bin/agent` `2026.06.04-8f81907`
**Concurrency:** 4 (per-verify isolated `$HOME` + `$HAPI_HOME`, no lock contention)

## Headline

**391 / 391 chats pass `agent acp` initialize + session/load (100.0%).**

The strict "ACP or unimportable" refusal contract is fully viable against the
operator's real `~/.cursor/chats/` library. Zero chats produce a verify_failed
state. The PR can ship as designed.

## Outcome distribution

| Result | Count | % |
|---|---|---|
| ok | 391 | 100.0 |
| verify_init_failed | 0 | 0.0 |
| verify_load_failed | 0 | 0.0 |
| verify_timeout | 0 | 0.0 |
| corrupted_store | 0 | 0.0 |
| spawn_failed | 0 | 0.0 |
| probe_crash | 0 | 0.0 |

## Performance

- Total audit elapsed: 550 s (~9 min, concurrency 4)
- Per-chat verify duration: avg 5.56 s, max 16.33 s
- Total store volume audited: 11.86 GB
- Largest single store: 4.09 GB (loaded successfully in 11 s)
- Smallest stores ~130 KB; small stores cluster around 5 s (probe spawn dominates)

## Method (single chat)

For each `~/.cursor/chats/<wsh>/<uuid>/store.db`:

1. `mkdtemp /tmp/hapi-acp-audit-<uuid8>-XXXX`
2. `cp store.db -> <tmp>/.cursor/acp-sessions/<uuid>/store.db`
3. Write sidecar `<tmp>/.cursor/acp-sessions/<uuid>/meta.json` =
   `{"schemaVersion":1,"cwd":"<tmp>"}`
4. Best-effort copy auth files (`cli-config.json`, `agent-cli-state.json`,
   `acp-config.json`) from real `~/.cursor` -> `<tmp>/.cursor`
5. Spawn `agent acp` with `HOME=<tmp>` `HAPI_HOME=<tmp>` `NO_COLOR=1`
6. JSON-RPC `initialize` (timeout 20 s) -> `session/load { sessionId, cwd, mcpServers: [] }`
   (timeout 30 s, replay drain 1.5 s)
7. Record outcome class and duration; rmtree tmp HOME

The probe shape mirrors `hub/src/cursor/acpVerifyProbe.ts` from
`heavygee/hapi#34` / `tiann/hapi#824` so the gate measures the exact code path
the upstream import endpoint will take.

## Implications for the upstream PR

- The strict refusal contract from the strategic plan stays intact: legacy
  store with `verify_load_failed` -> structured error, no HAPI row, source
  untouched. There were zero such cases in this audit, but the contract still
  matters for forward-compatibility if `cursor-agent` ever changes the on-disk
  schema.
- The PR body should cite this audit (391/391 = 100.0%) as the "why ACP-only is
  safe to ship" evidence. CSV at
  `docs/plans/2026-06-08-cursor-acp-verify-audit.csv` (fork-private; do NOT
  include in upstream diff).
- `audit-cursor-acp-verify.ts` ships in the upstream PR as a regression
  harness operators can re-run when `cursor-agent` updates.

## Reproduce

```bash
cd ~/coding/hapi/worktrees/cursor-import-acp
bun scripts/audit-cursor-acp-verify.ts --concurrency 4
# CSV lands at ~/coding/hapi/docs/plans/2026-06-08-cursor-acp-verify-audit.csv
```

Flags: `--limit N`, `--uuid <id>`, `--concurrency N`, `--csv <path>`,
`--prompt` (also drives a tiny `session/prompt`, costs tokens).

## Gate decision

>= 95% pass -> **proceed with implementation as designed.**

Audit returned 100.0%. Gate cleared.
