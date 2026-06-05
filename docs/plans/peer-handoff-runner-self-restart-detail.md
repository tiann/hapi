# FEATURE PEER — runner self-restart resilience

**Operator:** This HAPI session is the only lane for diagnosing and fixing the runner self-restart / systemd hand-off bug. Do not push the operator back to the orchestrator chat.

---

## Parent

- Orchestrator Cursor: `a890acd1-8251-482c-87a6-7d2cb6e47b84`
- Trigger session (where operator saw "no machine online"): `8903047b-1253-414b-9f1f-bb41f3d713b3` ("android watch", archived; resume now possible since runner restored)

## Operator request (verbatim)

> Yes we need to spawn a pier for this and get it done. If you could do the honors I would be extremely grateful

## Scope

**Local fork only.** Per `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md`, this stays in the soup stack — **not an upstream PR**. End users on `@twsxtd/hapi` npm install do not hit this; only operators running source via soup.

---

## Intake status (orchestrator DONE)

- [x] **1 Code search** — `cli/src/runner/run.ts` heartbeat + `cli/src/runner/controlClient.ts` `isRunnerRunningCurrentlyInstalledHappyVersion`; soup branches `feat/runner-skip-version-handoff-flag` + `fix/runner-handoff-preserves-argv` already in `~/.config/hapi/driver-manifest.yaml`
- [x] **2 Existing plan** — `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` (Fix A done, Fix B done, Fix C marked WON'T DO)
- [x] **3 Operator doc** — `docs/operator/runner-systemd.md` (drop-in, expected behaviour, verification)
- [x] **4 Drop-in installed** — `/etc/systemd/system/hapi-runner.service.d/10-disable-version-handoff.conf` sets `HAPI_DISABLE_VERSION_HANDOFF=1`, plus `ExecStartPre` `runner stop`
- [x] **5 Live incident captured** — see Evidence below

## Live evidence (2026-05-31 ~22:40 BST)

| Fact | Value |
|------|-------|
| Runner self-suicided | `~/.hapi/logs/2026-05-31-22-40-47-pid-65341-runner.log` |
| `HAPI_DISABLE_VERSION_HANDOFF` | set in unit env (`systemctl show -p Environment`) |
| Both fix branches | active in soup manifest |
| Drop-in `ExecStartPre` | present |
| Symptom | hub journal showed clean exit `code=exited, status=0/SUCCESS` → systemd `Restart=on-failure` did NOT restart → machine offline ~3 min until manual `sudo systemctl start` |
| Operator UI | session `8903047b` reported **"no machine online"** |

### Two distinct misbehaviours

**1) New invocation kills live runner anyway (env var leaks)**

Runner log line 30-32 at 22:40:47:

```
[RUNNER CONTROL] Current CLI mtime: 1779549472629, Runner started with mtime: 1780242730153
[RUNNER RUN] Runner version mismatch detected, restarting runner with current CLI version
Stopping runner with PID 24935
```

The new invocation **did** kill the live runner despite the env var. Either:
- The env var is honored only in the heartbeat path (`run.ts`) but not in `controlClient.ts` `isRunnerRunningCurrentlyInstalledHappyVersion`, OR
- The "Runner version mismatch" log fires before the env-var check (cosmetic), but the kill action shouldn't have happened — needs a code read on the actual conditional in the soup.

**2) Replacement invocation took SIGTERM seconds after start**

Same log lines 41-50:

```
22:40:47.532 [RUNNER RUN] Runner started successfully, waiting for shutdown request
22:40:47.532 [RUNNER RUN] Starting proper cleanup (source: os-signal, errorMessage: undefined)...
22:40:47.643 [RUNNER RUN] Process exiting with code: 0
```

The replacement registered the machine, then immediately got `os-signal` (SIGTERM) and exited cleanly. Likely systemd `ExecStart` was killed because **another invocation of the runner CLI** (probably from `hapi-use-driver` / `hapi-driver-rebuild`'s `runner stop`) raced with this one. Result: gap, no runner.

**3) systemd `Restart=on-failure` is wrong policy**

Even when (1) and (2) are fixed, any future clean exit (`process.exit(0)`) leaves the machine offline. The unit policy is wrong for this code path — it should be `Restart=always` or have explicit `RestartPreventExitStatus` exclusions, since the runner has no legitimate reason to ever exit-0 while the soup is in use.

Confirm: `Restart=on-failure` in `/etc/systemd/system/hapi-runner.service` (operator-controlled). The drop-in lives at `/etc/systemd/system/hapi-runner.service.d/10-disable-version-handoff.conf`.

---

## Your assignment (own all of this)

| # | Task |
|---|------|
| 1 | Reproduce: in worktree, simulate operator stopping/starting unit while live runner exists with mtime drift. Capture log. |
| 2 | Read `controlClient.ts` and `run.ts` in the worktree (NOT in `hapi-driver`). Confirm env var is honored in **both** the heartbeat path AND the `isRunnerRunningCurrentlyInstalledHappyVersion` "fresh invocation kills old" path. If the latter is missing the guard, that's the primary bug today. |
| 3 | If existing branches `feat/runner-skip-version-handoff-flag` + `fix/runner-handoff-preserves-argv` are already on `upstream/main`'s view of `controlClient.ts`/`run.ts`, **rebase them onto your worktree branch** (or cherry-pick) and verify. If they're not in upstream (likely true — they're soup-only), document the integration. |
| 4 | Fix the env-var leak so the kill action is also gated, not just the log. |
| 5 | Race fix: the parallel-invocation `runner stop` + new `start-sync` should not orphan systemd. Options: file lock on `runner.state.json`, or `ExecStartPre` that already-handles "another systemd start in flight". |
| 6 | systemd policy: change `Restart=on-failure` → `Restart=always` in the unit (or via drop-in). Add a guard so a deliberate `systemctl stop` does NOT trigger a restart loop (use `RestartPreventExitStatus=` or `Type=notify`). Operator doc update. |
| 7 | Add a one-line health probe: e.g. systemd `WatchdogSec=` notify, or external systemd timer that polls `/api/machines` and force-restarts the unit if proxmox machine drops. (Belt-and-braces for any path we miss.) |
| 8 | Verification matrix from plan §Verification matrix — execute, capture logs in `~/coding/hapi/localdocs/operator/`. |
| 9 | Commit on `fix/runner-handoff-systemd-resilience`; add manifest layer; `hapi-driver-rebuild --build-web --verify`; `sudo systemctl restart hapi-runner.service`; verify; report. |
| 10 | Update `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` "Definition of done" with completion tick + 2026-05-31 22:40 incident retrospective. |

## Do NOT

- Hand-edit `~/coding/hapi-driver` (rebuilt artifact only — soup manifest layer is the only legit path)
- Open an upstream PR — this stays local. Plan §"Why this is a local problem, not upstream" applies.
- Implement Fix C (true blue-green) — explicitly WON'T DO in the plan.
- Touch unrelated layers (voice stack, queued-bar fix) — single-feature peer.

## Worktree

`~/coding/hapi-runner-handoff` @ branch `fix/runner-handoff-systemd-resilience` (just created from `upstream/main`)

```
cd ~/coding/hapi-runner-handoff
git branch --show-current   # confirm
bun install                 # if you need to run tests
```

## Read first (in worktree, on disk)

- `docs/plans/2026-05-31-runner-self-restart-bluedeploy-fix.md` (full design)
- `docs/operator/runner-systemd.md` (drop-in, what's installed)
- `docs/operator/AGENTS.md` (fork canon)
- `~/coding/skills/spawn-peer-agents/SKILL.md` (for any sub-peer you spawn)

## Live verification commands (after each fix)

```bash
# baseline
systemctl is-active hapi-runner.service
cat ~/.hapi/runner.state.json | jq '{pid, startTime, startedWithCliMtimeMs, startedWithArgv}'

# simulate mtime drift on driver source while runner alive
touch ~/coding/hapi-driver/cli/src/index.ts
sleep 70   # past heartbeat
journalctl -u hapi-runner.service --since "2 min ago" | grep -iE "outdated|mismatch|self-restart|skipping"
systemctl is-active hapi-runner.service   # MUST stay active
cat ~/.hapi/runner.state.json | jq .pid   # MUST be unchanged

# simulate concurrent stop+start race
sudo systemctl stop hapi-runner.service
sleep 1
sudo systemctl start hapi-runner.service
sleep 5
curl -fsS http://127.0.0.1:3006/api/machines -H "Authorization: Bearer $JWT" | jq 'map(.id)'
```

## Report back to operator with

- Diff stat for the new commit(s)
- `Restart=` policy after change
- Log excerpts proving the version-mismatch path no longer kills
- Manifest snippet
- Updated plan / operator doc paths
- Confirmation that `hapi-driver-rebuild --build-web --verify` is green
- Any sub-peers you spawned (`@spawn-peer-agents` per skill)

---

## Friction reminders

- Steelman of "just remember the flag": already in place, today's incident proves it's insufficient — the env var didn't stop the kill, AND systemd's `Restart=on-failure` doesn't recover from clean exits. Two failure modes, two fixes minimum.
- Cheapest falsification: try `Restart=always` alone — if that single line ends the operator pain even with all other paths broken, the runner-side env-var work is decorative for daily ops.
- Risk: looping restart on a broken runner. Mitigate with `StartLimitBurst=` + `StartLimitIntervalSec=` so a genuinely broken runner doesn't pin CPU.
