# hapi-watch-activate-driver

Script reference only. **When to use it:** [feature-work-lifecycle.md § Stack path swing](./feature-work-lifecycle.md#stack-path-swing-vs-in-place-restart) — operator external shell, stack path swing — **not** soup dogfood when already on `~/coding/hapi/driver`.

Polls `hapi-sessions-health.sh --json` until **no blocking WORKING sessions**, then runs `hapi-use-driver`.

## Ouroboros rule (mandatory)

**Do not run this script from inside a HAPI Cursor agent turn** unless you pass an exclude for **this** session.

While the watch loop runs, the agent child process is still alive -> hub marks this session **WORKING** -> filtered count never reaches 0 -> deadlock. Operator recovery from a real deadlock: kill agent (exit 143) + watch child.

| Run from | OK? |
|----------|-----|
| External terminal / systemd / cron | Yes |
| Cursor agent turn with **no** exclude | **No** (logic deadlock - script refuses to start) |
| Agent turn with `--exclude-agent-session <id>` | Yes (will kill this agent on activate) |

## Usage

```bash
# Preferred: external shell after you confirm health
hapi-sessions-health.sh --json | jq '[.sessions[]|select(.status=="WORKING")]'
HAPI_STACK_SWITCH_YES=1 hapi-use-driver

# Watch loop (external shell, foreground)
hapi-watch-activate-driver --interval 20

# One-shot check
hapi-watch-activate-driver --once

# Exclude this hub session or Cursor agent id (prefix ok for sid)
hapi-watch-activate-driver \
  --exclude-sid 17f4a977 \
  --exclude-agent-session 6904d349-f576-489f-bcd7-972f37f3942a

# Background from inside agent turn, survives agent exit
setsid nohup env HAPI_STACK_SWITCH_YES=1 \
  hapi-watch-activate-driver \
  --exclude-agent-session "$CURSOR_AGENT_SESSION_ID" \
  --interval 15 \
  >> /tmp/hapi-watch-activate-driver.log 2>&1 < /dev/null &
disown
```

## Flags

| Flag / env | Effect |
|-----|--------|
| `--once` | Single check; exit 0 if activated, 2 if still blocked |
| `--interval <sec>` / `HAPI_WATCH_INTERVAL` | Poll interval (default 30) |
| `--exclude-sid <prefix>` / `HAPI_WATCH_EXCLUDE_SID` | Drop hub session by sid/sid8 (prefix match both ways) |
| `--exclude-agent-session <id>` / `HAPI_WATCH_EXCLUDE_AGENT_SESSION` | Drop session by Cursor `agentSessionId` (prefix match) |
| `--force-unsafe` | Bypass agent-parent guard (still deadlocks if **only** this session is WORKING) |

Auto-exclude: any WORKING row whose `procs[]` includes `hapi-watch-activate-driver` (the watch child itself).

## Guard

If launched under a Cursor/agent parent without any exclude or `--force-unsafe`, the script **refuses to start** (exit 3) with instructions. Walks up `PPID` chain looking for `/agent`, `cursor-agent`, or `cursor agent` in cmdline.

## Agent discipline

Orchestrator / meta bot must **not** background `hapi-watch-activate-driver` inside the same turn that is waiting for activation **without** the exclude. Tell the operator to run it externally, or run `hapi-use-driver` manually when `WORKING==0`.

When the watch fires `hapi-use-driver`, it restarts hub + runner -> **kills all live agent sessions including the one that launched the watch**. That's expected; the operator asked for the restart. Background-with-setsid lets the watch survive the agent exit so it can still trigger.

## Why set-and-forget failed (2026-06-20 postmortem)

One background watch is not one failure mode. The Jun 20 promotion hit **four** separate breaks in sequence:

1. **Wrong cwd (immediate REFUSE)** — first launch had `PWD` under `~/coding/hapi/driver/cli`. `hapi-use-worktree` correctly refused (self-deletion guard). Watch died on `exec` with no retry. **Fix:** watch now `cd`s to `HAPI_PRIMARY` (`~/coding/hapi`) before calling `hapi-use-driver`.

2. **Exclude gap (10-minute self-wait)** — watch excluded this session; `hapi-use-worktree` patient drain did not. Switch sat on `WORKING=1` (this session) for ~570s until the process was killed externally. **Fix:** shared `lib/patient-drain.sh` + env pass-through (landed same day).

3. **Process killed mid-drain (STALE lock)** — switch pid died at ~570s (before the 600s proceed-anyway timeout), leaving `switch.state=running` + orphan `stack.lock`. Likely cause: agent tool/MCP session teardown or a new shell command in the same agent turn killing the background tree despite `setsid nohup`. **Mitigation:** launch watch from an **external** tmux/SSH session for real set-and-forget; do not depend on agent-background for multi-minute drains.

4. **No retry on activation failure (watch exits)** — after stale lock, new watch polls reached `WORKING=0` but `hapi-use-driver` failed with `driver stack busy`; `exec` replaced the watch process, which exited on error. Operator had to manually clear lock and relaunch. **Fix:** watch runs activation in a subshell and **resumes polling** on failure; `driver_stack_autoclear_stale` clears dead-pid status before each wait.

Success on attempt 3 was partly **luck**: patient drain saw `WORKING=0` when this session briefly read idle (`thinking=false` between tool calls) — not because drain correctly excluded the orchestrator.

### Reliable launch recipe

```bash
cd ~/coding/hapi
setsid nohup env HAPI_STACK_SWITCH_YES=1 \
  hapi-watch-activate-driver \
  --exclude-agent-session "$CURSOR_AGENT_SESSION_ID" \
  --interval 15 \
  >> /tmp/hapi-watch-activate-driver.log 2>&1 < /dev/null &
disown
```

**Must** start from `~/coding/hapi` (not `driver/`). Prefer external terminal over agent-background for promotions that may wait on patient drain.

## Port ownership gate (2026-06-20)

Before `hapi-use-driver`, watch now calls `lib/hub-port-guard.sh`:

- **Pass:** `:3006` is free, or `hapi-hub.service` MainPID listens with cwd = active tree `hub/`.
- **Block:** any other bun hub on `:3006` (typical: `nohup bun run src/index.ts` from a feature worktree).

Symptom when blocked: `hapi-hub.service` crash-loops `EADDRINUSE`; operator UI regresses (wrong web bundle, missing soup layers) even though `driver/integration` and promotion stamp look fine.

Recovery: kill the rogue listener pid printed by the guard, `sudo systemctl start hapi-hub.service`, hard-reload PWA.

**Agent rule:** never bind a worktree hub to `:3006`. Pre-soup testing: [peer-stack.md](./peer-stack.md). Soup dogfood: [feature-work-lifecycle.md](./feature-work-lifecycle.md).
