# Session-attached jobs

Hub-persisted progress for work that **outlives the agent** — batch imports, `nohup` scripts, long drains — so the session list still shows something truthful while the chat is idle (`active: false`).

This is **not** in-agent thinking progress, todos, or `backgroundTaskCount`. Those die when the agent disconnects. Attached jobs live on the hub until you clear them.

Upstream: [tiann/hapi#1404](https://github.com/tiann/hapi/issues/1404).

## Relation to A2A (not work advertisements)

HAPI's Agent-to-Agent control plane ([discussion #1332](https://github.com/tiann/hapi/discussions/1332)) is a **different** object family. Do not merge them.

| | Session-attached jobs (#1404) | A2A `work_ad` (Layer 1) |
|--|------------------------------|-------------------------|
| Store | `session_jobs` | `events` / work-graph ledger |
| Surface | `SessionSummary.attachedJob` (list chrome) | Durable collaboration ledger |
| Question answered | "Is a long process still running on this session, and how far?" | "What is this session claiming about turn/project work for peers/overseer?" |
| Progress | Heartbeats + honest counts / indeterminate | Status vocabulary (`in_progress`, `done`, `failed`, `stale`, …) |
| Silence | UI amber after ~15m without heartbeat; status stays `running` until explicit exit | `expires_at` → `stale` / `unknown` — silence is **not** failure |
| Self-report | Optional counts/detail; `hapi job run` exit code is machine fact | Optional `AGENT_NOTIFY_SUMMARY` elevation (stays optional forever) |

Jobs enrich **Layer 0** session summaries (same layer as cite / inspect / ping). They are **not** Google A2A Tasks, and they are **not** a substitute for handoffs or work ads. Do not write job heartbeats into the A2A ledger. A privileged reader may *observe* `attachedJob` later; workers still must not poll the ledger as a work queue.

## When to attach

Attach a job **before** (or immediately when) you start process-shaped work that will keep running after the agent goes idle:

| Attach | Do not attach |
|--------|----------------|
| `nohup` / `setsid` / systemd oneshot that runs for hours–days | A tool call that finishes in this turn |
| Beets / rclone / compile / migrate / download batches | Normal coding edits and tests |
| External daemon you own for this session's goal | Claude/Codex Ctrl+B-style background tools |

If the operator would reopen the chat only to ask "how's it doing?", it belongs here.

## Which session id (contract)

Attached jobs bind to the **hub session row the operator sees** — the UUID in the web URL `/sessions/<id>`, the session list tile, and the chat transcript. That row is the only target for `PUT/PATCH/DELETE /api/sessions/:id/jobs/...` and the only place `attachedJob` appears in the UI.

| Surface | Session id source | Must match operator chat row |
|---------|-------------------|------------------------------|
| Shell `hapi job …` | First positional arg; docs use `"$HAPI_SESSION_ID"` | Yes |
| MCP `session_job` | Owning hapi CLI `client.sessionId` (stdio bridge is not a second id) | Yes |
| `HAPI_SESSION_ID` env | Exported by `exportHapiSessionEnv` when the session CLI bootstraps | Yes — **this chat**, not an internal worker row |

**Intended:** one hub row per operator chat. Runner resume/spawn passes `existingSessionId` so bootstrap, MCP bridge, and `HAPI_SESSION_ID` all equal the row the web UI opened.

**Known bug (remote Cursor runner):** shell `HAPI_SESSION_ID` can point at a runner worker row while the operator watches a different hub chat row. Jobs on the worker id update a session the operator is not viewing; MCP `session_job` on the chat row still works because the bridge is wired to the chat `client.sessionId`. Until fixed, pass the **chat URL uuid** explicitly to `hapi job` instead of trusting `$HAPI_SESSION_ID`. Hub merge/clear redirects (`jobsTransferredToSessionId`, `supersededBySessionId`) apply only when metadata links rows — not for unrelated live duplicates.

## Agent contract (specification)

Treat this like `ping_peer` / `inspect_peer`: it is first-class HAPI tooling, not a docs footnote.

### CLI supervisor (required for process-shaped work)

```bash
hapi job run "$HAPI_SESSION_ID" beets \
  --label 'beets import' \
  --remaining 150 --done 1637 --total 1787 --unit units \
  --detail 'album: …' \
  -- ./beets-import.sh
```

`hapi job run` registers the job, heartbeats on a timer while the child runs, then marks `completed`/`failed` from the exit code. An idle agent **cannot** heartbeat - set-once + nohup freezes the bar (counts stuck, UI goes stale after ~15m).

Do **not** start long work with MCP `session_job` `set` or a one-shot CLI `set` and then background the process. That is the wardrobe failure mode.

### MCP (update / clear / list only)

Tool name: `session_job` (Claude: `mcp__hapi__session_job`; Codex: `functions.hapi__session_job`; OpenCode/ACP: `hapi_session_job`).

**`action=set` is refused** over MCP. Start the meter with Shell + `hapi job run` (above). Then you may:

```json
{ "action": "update", "jobKey": "beets", "done": 1638, "total": 1787 }
{ "action": "update", "jobKey": "beets", "status": "completed" }
{ "action": "clear", "jobKey": "beets" }
{ "action": "list" }
```

### CLI manual path (self-heartbeating wrapper only)

Only when you own a wrapper that calls `update` at least every ~10 minutes (not an idle agent).
Mint one UUID per wrapper run and fence every PATCH so a key-reuse cannot steal progress:

```bash
RUN_ID="$(uuidgen)"   # or python -c 'import uuid; print(uuid.uuid4())'

hapi job set "$HAPI_SESSION_ID" beets \
  --label 'beets import' \
  --run-id "$RUN_ID" \
  --remaining 150 --done 1637 --total 1787 --unit units \
  --detail 'album: Some Artist - Some Album'

hapi job update "$HAPI_SESSION_ID" beets \
  --expected-run-id "$RUN_ID" \
  --remaining 149 --done 1638 --detail '…'

hapi job update "$HAPI_SESSION_ID" beets \
  --expected-run-id "$RUN_ID" \
  --status completed
# or
hapi job clear "$HAPI_SESSION_ID" beets --expected-run-id "$RUN_ID"
```

Same auth as `hapi ping-peer` (`HAPI_API_URL` / `CLI_API_TOKEN` or `hapi auth login`).

## Progress honesty (tiers)

| What you know | What to send | What the list shows |
|---------------|--------------|---------------------|
| Countable leftover | `--remaining N` + `--total M` (+ optional `--unit`) | `150 units left · 2d 4h` + bar fill when `total` is set |
| Countable fraction | `--done N --total M` | `91% · 1637/1787 units · 2d 4h` + bar fill |
| Stage only / unknown size | `--label` + `--detail` + heartbeats | `running · 2d 4h` + indeterminate bar |

**Bar fill:** the byte/progress bar moves only when `total` is set and you send `--done`/`--total` or `--remaining`/`--total`. `--remaining` alone (without `total`) updates the text label only — it is not a percent and does not tick the bar. Prefer `--done`/`--total` when you want visible byte-style progress.

**Elapsed** is always derived from hub `startedAt` (wall clock). It is **not** an ETA and there is no time-remaining field - operators get "how long has this been going" plus whatever honest count/detail you report, without a fake completion estimate.

Rules:

- Prefer **remaining+total** when the operator cares about "how much left" and you know the denominator.
- Prefer **done+total** when you want the simplest bar fill (byte-style progress).
- Do not send **remaining alone** expecting the bar to move — include `total` or use `done`/`total`.
- If you only know a stage name, put it in `--detail` and keep heartbeating — do **not** fake `total=100`.
- There is **no** `--percent` flag and **no** ETA / time-remaining field. Inventing either would train agents to lie.

## `startedAt` / elapsed (late attach)

Elapsed is honest wall clock from hub `startedAt`. Dogfood gotcha (music drain / beets):

| Call | `startedAt` behavior |
|------|----------------------|
| `PATCH` / `hapi job update` | **Rejected** if you send `startedAt` (`unrecognized_keys`). Progress/heartbeat only. |
| `PUT` / `hapi job set` without `--started-at` | Keeps the existing clock when the job already exists; first create stamps now. |
| `PUT` / `hapi job set --started-at <epoch-ms>` | Sets/corrects the clock (explicit body field). |
| `DELETE` then `PUT` with `startedAt` | Always works — including older hubs that ignored PUT corrections. |

**Prefer `update` for heartbeats** so you never wipe the clock. Only correct historical start when a late attach stamped attach-time instead of process start:

```bash
# epoch ms for when the drain actually started (example)
START_MS=1785304595000

hapi job clear "$HAPI_SESSION_ID" beets
hapi job set "$HAPI_SESSION_ID" beets \
  --label 'beets import' \
  --started-at "$START_MS" \
  --remaining 0 --done 1787 --total 1787 --unit units \
  --status completed \
  --detail 'ALL_DONE'

# or, on hubs that honor explicit PUT startedAt without delete:
hapi job set "$HAPI_SESSION_ID" beets \
  --label 'beets import' \
  --started-at "$START_MS" \
  --remaining 12 --done 1775 --total 1787 --unit units
```

Then keep using `hapi job update` for counts/detail/status.

## Heartbeat recipe

Wrap the long process so something calls `hapi job update` on a timer (or on each unit completed). Minimum viable indeterminate job:

```bash
RUN_ID="$(uuidgen)"
hapi job set "$HAPI_SESSION_ID" rsync-backup \
  --run-id "$RUN_ID" --label 'rsync backup' --detail 'phase: copy'
# in a loop / cron / companion script:
hapi job update "$HAPI_SESSION_ID" rsync-backup \
  --expected-run-id "$RUN_ID" --detail "phase: copy · $(date -u +%H:%M)Z"
```

When the process exits, mark completed/failed or clear. A stuck green/amber chip with a dead PID is worse than no chip.

## CLI / API reference

```bash
hapi job set <session> <job-key> --label <text> [--started-at MS] [--run-id UUID] [progress flags]
hapi job update <session> <job-key> [--expected-run-id UUID] [progress flags]   # no startedAt
hapi job clear <session> <job-key> [--expected-run-id UUID]
hapi job list <session>
hapi job run <session> <job-key> --label <text> -- <cmd>…
hapi job --help
```

Needs a hub/CLI build that includes `job` (soup / feat — global npm releases may lag).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/sessions/:id/jobs` | List jobs |
| `PUT` | `/api/sessions/:id/jobs/:jobKey` | Upsert (`AttachedJobUpsert`; optional `startedAt`, `runId`) |
| `PATCH` | `/api/sessions/:id/jobs/:jobKey` | Progress/heartbeat (`AttachedJobPatch`; **no** `startedAt`; optional `expectedRunId`) |
| `DELETE` | `/api/sessions/:id/jobs/:jobKey?expectedRunId=` | Clear (optional fence; 409 on run mismatch) |

Primary running job is enriched onto `GET /api/sessions` as `attachedJob` and pushed on `session-updated` SSE patches.

## Sidebar pin (Settings → Display)

Attached jobs ship with a **tri-state** "Pin in-progress sessions" control (not a yes/no):

| Mode | Floats to In progress |
|------|------------------------|
| Off | Nothing |
| Long-running jobs (default) | Sessions with a running attached job (even when the agent is idle) |
| Working & pending | Jobs **plus** thinking / pending / in-agent background tasks (storage key `all`). Quiet connected stays in project folders. |

Unset preference defaults to **Long-running jobs** — that is the product stand for this capability. Legacy `true` maps to Working & pending; legacy `false` maps to Off.

## Related

- [Supported Agents](./agents.md) — flavors and resume
- [How it Works](./how-it-works.md) — CLI ↔ hub ↔ web
- CLI: `hapi job --help`, `cli/README.md`
- A2A control plane: [discussion #1332](https://github.com/tiann/hapi/discussions/1332) (Layer 1 work ads / handoffs — separate from this feature)
