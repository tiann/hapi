# Runner systemd integration (operator-local)

Daily-driver HAPI here runs as **two systemd services**:

```
hapi-hub.service     → bun run hub from $ACTIVE/hub
hapi-runner.service  → bun run cli   from $ACTIVE/cli (start-sync)
```

Both follow `~/coding/hapi-active` (symlinked by `hapi-use-driver` / `hapi-use-worktree`).

The runner's CLI ships an mtime-driven self-restart - when source files change underneath it, the runner spawns a replacement and `process.exit(0)`'s. Under systemd, **`Restart=on-failure` does not restart on clean exits**, so the runner stays dead until manual intervention. Soup rebuilds (`hapi-driver-rebuild`) trip this every time they touch the active tree.

The 2026-05-31 22:40 BST incident proved the env-var-only mitigation was insufficient: a terminal-launched `hapi runner start-sync` from `/home/heavygee/coding/hapi` (without the env var exported) saw mtime drift, killed the live systemd-owned runner via HTTP /stop, then took its own SIGTERM ~200ms later and exited cleanly - leaving the machine offline for 3 minutes until manual `systemctl start`. The runner-systemd-resilience layer (see below) makes this class of incident structurally impossible: even if every CLI-level check regresses, `Restart=always` + the watchdog timer bring the machine back within seconds.

## Local mitigation - resilience stack

Single combined soup branch (`fix/runner-handoff-systemd-resilience`) carries:

1. The two prior soup commits (env-var opt-out + argv preservation/handoff verification).
2. A **persisted** `runnerDisableVersionHandoff:true` in `~/.hapi/settings.json` so the opt-out survives env-var leaks.
3. A **start-lock** in `cli/src/runner/run.ts` (`~/.hapi/runner.start.lock`) that serialises concurrent `runner start-sync` invocations.
4. Systemd templates under `cli/systemd/*` (drop-in with `Restart=always` + watchdog timer).

### Drop-in (replaces the older `10-disable-version-handoff.conf`)

```ini
# /etc/systemd/system/hapi-runner.service.d/10-resilience.conf
[Unit]
StartLimitBurst=10
StartLimitIntervalSec=300

[Service]
Environment=HAPI_DISABLE_VERSION_HANDOFF=1
ExecStartPre=/bin/bash -lc '/home/heavygee/.bun/bin/bun run --cwd /home/heavygee/coding/hapi-active/cli /home/heavygee/coding/hapi-active/cli/src/index.ts runner stop || true'
Restart=always
RestartSec=5
RestartPreventExitStatus=2
```

`Restart=always` is the big lever - any future clean exit gets restarted by systemd within 5s, regardless of cause. `StartLimitBurst=10 / StartLimitIntervalSec=300` prevents a genuinely broken runner from pinning CPU (note: must be in `[Unit]`, systemd ignores them in `[Service]`). `RestartPreventExitStatus=2` skips restart on fatal config errors.

The env var + `ExecStartPre` are unchanged from the prior drop-in. The env var is honored by `cli/src/runner/run.ts` heartbeat and `cli/src/runner/controlClient.ts:isRunnerRunningCurrentlyInstalledHappyVersion`; both ALSO check the persisted setting now so the env var leaking out of any future spawn is no longer fatal.

### Watchdog timer (belt-and-braces)

Polls `/cli/machines/<machineId>` every 60s. If the hub reports the machine inactive or `runnerState.status != "running"` AND the runner's local heartbeat is older than 30s, restarts the unit.

### Setup (one-time)

```bash
# 1. Install resilience drop-in (replaces 10-disable-version-handoff.conf)
sudo cp ~/coding/hapi-active/cli/systemd/hapi-runner-resilience.conf \
        /etc/systemd/system/hapi-runner.service.d/10-resilience.conf
sudo rm -f /etc/systemd/system/hapi-runner.service.d/10-disable-version-handoff.conf

# 2. Install watchdog units
sudo cp ~/coding/hapi-active/cli/systemd/hapi-runner-watchdog.service \
        /etc/systemd/system/hapi-runner-watchdog.service
sudo cp ~/coding/hapi-active/cli/systemd/hapi-runner-watchdog.timer \
        /etc/systemd/system/hapi-runner-watchdog.timer

# 3. Allow the unit user to restart the runner without password.
sudo tee /etc/sudoers.d/hapi-watchdog <<'EOF'
heavygee ALL=(root) NOPASSWD: /bin/systemctl restart hapi-runner.service
EOF
sudo chmod 0440 /etc/sudoers.d/hapi-watchdog
sudo visudo -c -f /etc/sudoers.d/hapi-watchdog   # must report "parsed OK"

# 4. Persist the env var as a settings.json key (env-leak hardening).
jq '.runnerDisableVersionHandoff = true' ~/.hapi/settings.json > /tmp/s.json && \
    mv /tmp/s.json ~/.hapi/settings.json

# 5. Activate
sudo systemctl daemon-reload
sudo systemctl restart hapi-runner.service        # picks up new drop-in
sudo systemctl enable --now hapi-runner-watchdog.timer
```

### Verify

```bash
systemctl show hapi-runner.service -p Restart -p RestartUSec \
    -p StartLimitBurst -p StartLimitIntervalUSec -p RestartPreventExitStatus -p Environment
# Expect:
#   Restart=always
#   RestartUSec=5s
#   StartLimitBurst=10
#   StartLimitIntervalUSec=5min
#   RestartPreventExitStatus=2
#   Environment=... HAPI_DISABLE_VERSION_HANDOFF=1 ...

systemctl list-timers hapi-runner-watchdog.timer
# Expect: NEXT fires in <60s window, LAST recent

journalctl -u hapi-runner-watchdog.service --since '5 min ago' --no-pager | tail -3
# Expect: "[watchdog] machine <uuid> active + runner=running on http://...; no action"
```

## Required soup layer

Single layer in `~/.config/hapi/driver-manifest.yaml`:

| Branch | Effect |
|--------|--------|
| `fix/runner-handoff-systemd-resilience` | Cherry-picks the two prior soup commits; adds persisted opt-out, start-lock, systemd templates |

The older `feat/runner-skip-version-handoff-flag` + `fix/runner-handoff-preserves-argv` are now superseded by this branch (they're cherry-picked into it). Drop them from the manifest when adopting this layer.

## Verification matrix

| Scenario | Expected |
|----------|----------|
| `hapi-driver-rebuild` + soup changes mtime on `cli/package.json` | Runner log shows no `outdated` / `self-restart` entries; `systemctl is-active hapi-runner.service` stays `active`; `MainPID` does not change across heartbeat ticks. With `DEBUG=1` the runner also logs `Version-handoff disabled (env=true, setting=true); skipping mtime/version drift self-restart` |
| Terminal `hapi runner start-sync` without env var exported | persisted `runnerDisableVersionHandoff:true` honored; "Runner already running with matching version" -> exit 0; live runner unaffected |
| Two concurrent `hapi runner start-sync` invocations (race) | Second invocation waits up to 6s on `runner.start.lock`; by then first has taken over; second sees "Runner already running with matching version" -> exit 0; no kill of either |
| Manual `systemctl kill -s KILL hapi-runner.service` | systemd restarts within 5s (`Restart=always`); watchdog timer's next tick sees healthy state |
| Hub reports machine offline + heartbeat > 30s | Watchdog runs `sudo systemctl restart hapi-runner.service`; journal entry in `hapi-runner-watchdog.service` |
| `hapi-use-driver` swing | systemd restarts the unit; `ExecStartPre` stops any orphaned runner; new runner reads the same drop-in env; machine reappears within ~5s |

### Live verification 2026-05-31 (post-incident)

After installing the resilience drop-in via `daemon-reload` (no service restart):

- `systemctl show hapi-runner.service -p Restart` -> `Restart=always` (was `on-failure`).
- `StartLimitIntervalUSec=5min`, `StartLimitBurst=10` (was 10s default + 5).
- `RestartUSec=5s`, `RestartPreventExitStatus=2`, `HAPI_DISABLE_VERSION_HANDOFF=1` all present in unit env.
- Watchdog timer enabled, fires every 60s, dry-run + live-run both correctly identify the live runner as healthy: `machine f9bb3c9e-... active + runner=running on http://127.0.0.1:3006; no action`.
- `~/.hapi/settings.json` has `runnerDisableVersionHandoff: true` so the next start-sync from any terminal context inherits the opt-out without env var.

Earlier (Fix A + B only) verification, retained for context:
- `runner.state.json` shows `startedWithArgv: ["runner","start-sync","--workspace-root","/home/heavygee/coding","--workspace-root","/home/heavygee/coding/hapi-driver"]` - Fix B persistence confirmed.
- Touched `~/coding/hapi-driver/cli/package.json` (mtime drift simulation). 70 seconds later (one heartbeat past): `MainPID` unchanged at 33332, `ActiveState=active`. Pre-fix behavior would have been a new pid or `inactive`. Fix A flag confirmed in production.

## 2026-06-11 update - layout move + pre-flight/auto-revert

The post-2026-06-01 folder reorg moved the watchdog out of `cli/systemd/` (no longer exists at HEAD) and into the primary repo's `scripts/tooling/`. The watchdog had been silently dead since that move because its systemd unit `ExecStart=` still pointed at the old path.

Three outages on 2026-06-10/11 (00:03, 02:14, 02:18 BST) drove a second pass:

1. **Watchdog restored at `scripts/tooling/hapi-runner-watchdog.sh`** (tracked in primary repo, survives rebuilds). Two latent bugs in the original script also fixed:
   - Probed `/cli/machines/` (returns SPA HTML). Now probes `/api/machines`.
   - Authenticated using the `cliApiToken` directly as a Bearer. Now does the `/api/auth` exchange first to get a JWT.
   - Used `jq` without `-r`, so `HEALTHY` got the literal string `"true"` (with quotes) and the comparison always failed.
   - Read `.lastHeartbeat` from `runner.state.json` which doesn't exist in the current schema. Now uses file mtime directly.

2. **Pre-flight schema check in `hapi-use-worktree.sh`** runs BEFORE the active-link swap and BEFORE the hub stop. Reads target `SCHEMA_VERSION` from `<worktree>/hub/src/store/index.ts` and compares to live `PRAGMA user_version`. If a downgrade is required and `hapi-driver-db-prep.sh` has no path for any hop, the script refuses with a clear three-option recovery message. No services are touched. Skip with `HAPI_SKIP_DB_PREP=1` (mirrors db-prep's own bypass).

3. **Post-swap self-verification + auto-revert in `hapi-use-worktree.sh`** runs AFTER the systemctl restart cycle. Checks (a) hub active + listening on `:3006`, (b) hub `/api/auth` + `/api/machines` answer correctly, (c) runner active, (d) runner registers in `/api/machines` with `runnerState.status == "running"` within 30s. If any fails: swings the symlink back to `PREV_ACTIVE`, re-runs `hapi-driver-db-prep.sh` against it (in case the failed target downgraded the DB), restarts services, and exits non-zero. Skip with `HAPI_SKIP_VERIFY=1`.

### Operator-side patch (one-time, when adopting this update)

```bash
# Update the watchdog ExecStart to the tracked location.
sudo sed -i 's|ExecStart=.*hapi-runner-watchdog.sh|ExecStart=/home/heavygee/coding/hapi/scripts/tooling/hapi-runner-watchdog.sh|' \
  /etc/systemd/system/hapi-runner-watchdog.service
sudo systemctl daemon-reload
sudo systemctl restart hapi-runner-watchdog.timer

# Verify
systemctl cat hapi-runner-watchdog.service | grep ExecStart
journalctl -u hapi-runner-watchdog.service --since '2 min ago' --no-pager | tail -3
# Expect: "[watchdog] machine <uuid> present + runner running on http://...; no action"
```

### Untouched outage class - hub watchdog

The 2026-06-11 00:03 + 02:14 outages were "operator (or HAPI agent) ran `sudo systemctl stop hapi-hub.service` and never started it back" - the hub's own auto-restart only fires on `Result=exit-code`, not on intentional `systemctl stop`. Pre-flight + auto-revert catch this only when the operator went through `hapi-use-worktree`. A symmetric `hapi-hub-watchdog.{service,timer}` (mirroring the runner's) is the natural next layer; deferred for now since the existing safety nets cover the in-script paths.

## Related

- `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` - problem statement, evidence, design, 22:40 incident retrospective
- `scripts/tooling/hapi-runner-watchdog.sh` - the watchdog probe script (post-2026-06-11 location)
- `scripts/tooling/hapi-use-worktree.sh` - pre-flight + auto-revert (`preflight_schema_check`, `verify_active_stack`, `revert_active_stack`)
- `scripts/tooling/hapi-driver-db-prep.sh` - schema migration adapter (forward auto, reverse via cases)
- `docs/tooling/driver-soup.md` - manifest workflow
- `scripts/tooling/hapi-runner-from-active.sh` - the `ExecStart` helper
