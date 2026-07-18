# macOS Runner LaunchAgent (supported topology)

HAPI supports one **direct** LaunchAgent per canonical `HAPI_HOME`. The job runs absolute `bun`, the absolute CLI entrypoint, and `runner start-sync`. Do not put a shell supervisor, Terminal/AppleScript fallback, PM2 wrapper, or independent monitor loop around this job. Those topologies cannot enable destructive reconciliation and remain report-only.

## 1. Prepare report-only configuration

Set the paths for this installation. Resolve symlinks before continuing.

```bash
export HAPI_HOME="$(cd "${HAPI_HOME:-$HOME/.hapi}" && pwd -P)"
export HAPI_BUN="$(command -v bun)"
export HAPI_CLI_ENTRY="/ABSOLUTE/PATH/TO/hapi/cli/src/index.ts"
export HAPI_CLI_DIR="$(dirname "$(dirname "$HAPI_CLI_ENTRY")")"
export HAPI_HOME_HASH="$(printf %s "$HAPI_HOME" | shasum -a 256 | cut -c1-12)"
export HAPI_RUNNER_LABEL="run.hapi.runner.${HAPI_HOME_HASH}"
export HAPI_RUNNER_PLIST="$HOME/Library/LaunchAgents/${HAPI_RUNNER_LABEL}.plist"
mkdir -p "$HAPI_HOME/logs" "$HOME/Library/LaunchAgents"
```

Create `${HAPI_HOME}/runner-reconcile.json` atomically with permissions `0600`. The first rollout must stay in `report` mode; the emergency kill switch stays off because report mode never signals startup candidates.

```bash
tmp="$(mktemp "$HAPI_HOME/.runner-reconcile.XXXXXX")"
cat >"$tmp" <<JSON
{
  "version": 1,
  "mode": "report",
  "killSwitch": false,
  "allowedWorkspaceRoots": ["/Users/example/Documents/Playground"]
}
JSON
chmod 600 "$tmp"
mv -f "$tmp" "$HAPI_HOME/runner-reconcile.json"
```

Do not change `mode` to `enforce` until the installed launch context, protected-path preflight, report inventory, and interrupted-runner canary have all passed review.

Before stopping any existing runner, bootstrap a one-shot LaunchAgent using the same absolute Bun, entrypoint, `WorkingDirectory`, `HAPI_HOME`, and workspace roots. It must successfully run `${HAPI_BUN} ${HAPI_CLI_ENTRY} --help` and open every configured root from the launchd context. Boot out the one-shot job afterward. If it fails, preserve the existing runner and fix TCC/path access first; never enable a failed-job KeepAlive loop as a probe.

## 2. Remove unsupported supervisors

First list the current GUI-domain jobs and save any old files for rollback:

```bash
uid="$(id -u)"
launchctl print "gui/$uid" | grep -i hapi || true
mkdir -p "$HAPI_HOME/launchagent-backup"
cp -p "$HOME/Library/LaunchAgents/"*hapi*runner*.plist "$HAPI_HOME/launchagent-backup/" 2>/dev/null || true
```

For every old runner label, capture its PID, stop it, and verify settlement before installing the direct job:

```bash
old_pid="$(launchctl print "gui/$uid/OLD_RUNNER_LABEL" 2>/dev/null | awk '/pid =/{print $3; exit}')"
launchctl bootout "gui/$uid/OLD_RUNNER_LABEL" 2>/dev/null || true
if [ -n "$old_pid" ]; then
  for _ in $(seq 1 200); do kill -0 "$old_pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$old_pid" 2>/dev/null && { echo "old runner did not settle" >&2; exit 1; }
fi
```

Also disable any LaunchAgent or login item that invokes a supervisor script, `osascript`/Terminal, PM2, `nohup`, or a `while true` health loop. Do not kill candidate session process groups from a name match. Generate the read-only legacy inventory and manually cross-check PID birth token, PGID, HAPI/native IDs, and active-turn evidence first. An unjournaled process is never automatically killable.

## 3. Install the direct plist atomically

Write a temporary plist. Every path below must be absolute.

```bash
tmp_plist="$(mktemp "$HOME/Library/LaunchAgents/.hapi-runner.XXXXXX")"
cat >"$tmp_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HAPI_RUNNER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${HAPI_BUN}</string>
    <string>${HAPI_CLI_ENTRY}</string>
    <string>runner</string>
    <string>start-sync</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HAPI_HOME</key><string>${HAPI_HOME}</string>
    <key>HAPI_RUNNER_SUPERVISED</key><string>launchd</string>
  </dict>
  <key>WorkingDirectory</key><string>${HAPI_CLI_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>${HAPI_HOME}/logs/runner.log</string>
  <key>StandardErrorPath</key><string>${HAPI_HOME}/logs/runner.log</string>
</dict>
</plist>
PLIST
plutil -lint "$tmp_plist"
chmod 600 "$tmp_plist"
mv -f "$tmp_plist" "$HAPI_RUNNER_PLIST"
```

Bootstrap it in the intended user's GUI domain and verify exactly one owner:

```bash
launchctl bootstrap "gui/$uid" "$HAPI_RUNNER_PLIST"
# RunAtLoad starts the job. Do not use kickstart -k here: it can kill the first
# healthy owner and race the successor against kernel-lock release.
launchctl print "gui/$uid/$HAPI_RUNNER_LABEL"
hapi runner status
```

At runtime, `PPID=1` and `HAPI_RUNNER_SUPERVISED=launchd` are only preliminary signals. Before destructive reconciliation can enter `enforce`, HAPI also verifies that the current PID belongs to the canonical `gui/<uid>/run.hapi.runner.<home-hash>` job, that launchd loaded the expected private non-symlink plist, and that its exact program arguments, `HAPI_HOME`, and working directory match the running process. A shell `exec`, Terminal/AppleScript, monitor wrapper, mismatched PID, stale plist, or unreadable evidence fails closed to report-only. `hapi runner status` reports the same identity verdict.

The runner must pass the read-only privacy preflight for the CLI entrypoint and every configured workspace root. A denial forces report-only operation; grant the launch context access and rerun the canary rather than bypassing the preflight.

## 4. Rollback

Rollback stops the direct job and restores the backed-up plist. It does not signal session process groups.

```bash
launchctl bootout "gui/$uid/$HAPI_RUNNER_LABEL" 2>/dev/null || true
rm -f "$HAPI_RUNNER_PLIST"
# Copy the chosen backup into ~/Library/LaunchAgents, then bootstrap it explicitly if required.
```

Keep `${HAPI_HOME}/runner-reconcile.json` in `report` (or set `killSwitch` to `true`) during rollback. Preserve runner logs, the ownership journal, and the dated legacy inventory for diagnosis.
