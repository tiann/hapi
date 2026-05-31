# hapi-watch-activate-driver

Polls `hapi-sessions-health.sh --json` until **no blocking WORKING sessions**, then runs `hapi-use-driver` (restarts hub + runner on `:3006`).

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
