# Session-attached jobs

Hub-persisted progress for work that **outlives the agent** — batch imports, `nohup` scripts, long drains — so the session list still shows something truthful while the chat is idle (`active: false`).

This is **not** in-agent thinking progress, todos, or `backgroundTaskCount`. Those die when the agent disconnects. Attached jobs live on the hub until you clear them.

Upstream: [tiann/hapi#1404](https://github.com/tiann/hapi/issues/1404).

## When to attach

Attach a job **before** (or immediately when) you start process-shaped work that will keep running after the agent goes idle:

| Attach | Do not attach |
|--------|----------------|
| `nohup` / `setsid` / systemd oneshot that runs for hours–days | A tool call that finishes in this turn |
| Beets / rclone / compile / migrate / download batches | Normal coding edits and tests |
| External daemon you own for this session's goal | Claude/Codex Ctrl+B-style background tools |

If the operator would reopen the chat only to ask "how's it doing?", it belongs here.

## Agent contract (specification)

HAPI does **not** write your batch scripts. You (the agent) create the process **and** feed the meter.

1. **Register** with a stable `job-key` (1–128 chars: alnum / `.` `_` `-`).
2. **Heartbeat** at least every ~10 minutes while running (UI amber after ~15 minutes quiet).
3. **Report progress honestly** — see tiers below. Never invent a bare percent.
4. **Finish cleanly** — `--status completed|failed` or `hapi job clear`.

Session id: prefer `"$HAPI_SESSION_ID"` (exported into every HAPI-wrapped agent). Prefix match also works.

```bash
hapi job set "$HAPI_SESSION_ID" beets \
  --label 'beets import' \
  --remaining 150 --done 1637 --total 1787 --unit units \
  --detail 'album: Some Artist - Some Album'

hapi job update "$HAPI_SESSION_ID" beets --remaining 149 --done 1638 --detail '…'

hapi job update "$HAPI_SESSION_ID" beets --status completed
# or
hapi job clear "$HAPI_SESSION_ID" beets
```

Same auth as `hapi ping-peer` (`HAPI_API_URL` / `CLI_API_TOKEN` or `hapi auth login`).

## Progress honesty (tiers)

| What you know | What to send | What the list shows |
|---------------|--------------|---------------------|
| Countable leftover | `--remaining N` (+ optional `--unit`) | `150 units left · 2d 4h` |
| Countable fraction | `--done N --total M` | `91% · 1637/1787 units · 2d 4h` |
| Stage only / unknown size | `--label` + `--detail` + heartbeats | `running · 2d 4h` + indeterminate bar |

**Elapsed** is always derived from hub `startedAt` (wall clock since register). It is **not** an ETA and there is no time-remaining field - operators get "how long has this been going" plus whatever honest count/detail you report, without a fake completion estimate.

Rules:

- Prefer **remaining** when the operator cares about "how much left".
- Prefer **done+total** when both ends of a fraction exist (UI may derive %).
- If you only know a stage name, put it in `--detail` and keep heartbeating — do **not** fake `total=100`.
- There is **no** `--percent` flag and **no** ETA / time-remaining field. Inventing either would train agents to lie.

## Heartbeat recipe

Wrap the long process so something calls `hapi job update` on a timer (or on each unit completed). Minimum viable indeterminate job:

```bash
hapi job set "$HAPI_SESSION_ID" rsync-backup --label 'rsync backup' --detail 'phase: copy'
# in a loop / cron / companion script:
hapi job update "$HAPI_SESSION_ID" rsync-backup --detail "phase: copy · $(date -u +%H:%M)Z"
```

When the process exits, mark completed/failed or clear. A stuck green/amber chip with a dead PID is worse than no chip.

## CLI reference

```bash
hapi job set <session> <job-key> --label <text> [options]
hapi job update <session> <job-key> [options]
hapi job clear <session> <job-key>
hapi job list <session>
hapi job --help
```

Primary running job is enriched onto `GET /api/sessions` as `attachedJob` and pushed on `session-updated` SSE patches.

## Related

- [Supported Agents](./agents.md) — flavors and resume
- [How it Works](./how-it-works.md) — CLI ↔ hub ↔ web
- CLI: `hapi job --help`, `cli/README.md`
