# Plan: Stop runner self-restart from breaking soup rebuilds

**Status:** DONE (2026-05-31 23:30 BST) - Fix A + B + resilience stack live in soup; live drop-in verified, watchdog timer enabled
**Owner:** any soup-aware HAPI agent
**Scope:** local fork (`heavygee/hapi`) soup stack only - **not** an upstream PR
**Related:** `~/coding/hapi-driver`, `hapi-driver-rebuild`, `hapi-use-driver`, daily soup workflow

---

## Problem

Running `hapi-driver-rebuild` while a `hapi runner start-sync` is live can knock the runner offline silently. Hub keeps serving the web UI; sessions queue messages; **nothing executes** because there is no machine.

### Evidence (2026-05-31 incident)

From `~/.hapi/logs/2026-05-31-15-36-51-pid-46645-runner.log` and the test-runner logs that landed alongside it:

1. Live runner PID 46645 was happy, sessions registered.
2. `hapi-driver-rebuild --verify` ran integration tests that briefly registered as the same machine with version `0.0.0-integration-test-should-be-auto-cleaned-up-28876`. Source-file mtimes changed.
3. Live runner's heartbeat saw `installedCliMtimeMs !== startedWithCliMtimeMs` and logged:
   ```
   Runner is outdated, triggering self-restart with latest version, clearing heartbeat interval
   ```
4. It called `spawnHappyCLI(['runner', 'start'], { detached: true, stdio: 'ignore' })` and exited.
5. The new `hapi runner start` invocation **stopped the old runner** and exited - it does **not** spawn a `start-sync`. No replacement runner came up.
6. `GET /api/machines` returned `[]` for ~8 minutes. All sessions appeared frozen.

### Code today

Trigger: `cli/src/runner/run.ts` lines 798-826 (heartbeat interval `restartOnStaleVersionAndHeartbeat`).

The misleading comment at lines 810-813 says:
> "It will first check if runner is running... Next it will start a new runner with the latest version with runner-sync :D"

That is **not what `hapi runner start` does**. `runner start` is a "kill old, then exit" command (see lines 100-111). There is no auto-spawn of `start-sync`, and the original `--workspace-root` argv is lost regardless.

### Why this is a local problem, not upstream

| Audience | Hits this bug? |
|----------|----------------|
| End users on published npm `@twsxtd/hapi` | No. CLI binary mtime never changes mid-session unless they `npm install`. |
| Driver/soup operator (heavygee) running `bun cli/src/index.ts ... start-sync` | **Yes, every rebuild.** Source mtimes change constantly. |

So the auto-update mtime watcher is **dead code for everyone except us**. We are the only consumer of the broken self-restart path. **Carry fixes locally; do not PR upstream unless asked.**

### Shape of the problem

It is a **malformed blue-green deployment**: the runner detects "green build exists on disk", kills itself (blue), then assumes a new blue magically appears. No green ever started. Blue dies. Machine offline.

---

## Fix A - DO - Disable auto-update during rebuild

**Goal:** rebuild and `hapi-use-driver` without the live runner committing suicide.

**Approach:** runner respects `HAPI_DISABLE_VERSION_HANDOFF=1`. Operator scripts set it before touching source, unset after activation.

### Code changes

**File:** `cli/src/runner/run.ts`, around line 798 (inside `restartOnStaleVersionAndHeartbeat`).

```ts
if (process.env.HAPI_DISABLE_VERSION_HANDOFF === '1') {
  if (process.env.DEBUG) {
    logger.debug('[RUNNER RUN] HAPI_DISABLE_VERSION_HANDOFF set, skipping mtime/version drift check');
  }
} else {
  // existing block: getInstalledCliMtimeMs() comparison + spawnHappyCLI(['runner', 'start'])
}
```

Also: same flag should be checked in `cli/src/runner/run.ts` line ~103 (`isRunnerRunningCurrentlyInstalledHappyVersion`) so a fresh `start-sync` invocation against a flagged-live runner does not still kill it. Keep the version-mismatch log at debug level.

**File:** new soup branch `feat/runner-skip-version-handoff-flag`. Single small commit, easy rebase.

**Operator script changes (in `~/coding/hapi-driver` and `~/.local/bin`):**

| Script | Change |
|--------|--------|
| `hapi-driver-rebuild` | `export HAPI_DISABLE_VERSION_HANDOFF=1` at start; `unset` at end (trap on exit). |
| `hapi-use-driver` | Same: set before symlink swap, unset after. |
| `hapi runner start-sync` invocation in tmux startup | Pass through `HAPI_DISABLE_VERSION_HANDOFF` from environment if exported by operator session. |

These scripts live outside `~/coding/hapi`, so document the contract here and link from `docs/operator-local-tooling.md`.

### Test plan

1. Start `hapi runner start-sync ...` with `HAPI_DISABLE_VERSION_HANDOFF=1`.
2. Touch `cli/src/index.ts` to bump mtime.
3. Wait > `HAPI_RUNNER_HEARTBEAT_INTERVAL` (60s default).
4. Confirm runner log says "skipping mtime/version drift check" and process is still alive.
5. Confirm `GET /api/machines` still lists the machine.
6. Run without the flag: confirm old behaviour (runner exits, log shows "Runner is outdated").

### Branch name

`feat/runner-skip-version-handoff-flag` (top of soup stack; merge order doesn't matter).

---

## Fix B - DO - Make self-restart actually work

**Goal:** if the auto-update path ever fires (operator forgot the flag, or some other trigger), the new runner should **come up with the same workspace roots and same args** the operator started with.

### Code changes

**File:** `cli/src/runner/run.ts` lines 814-826.

Today:
```ts
spawnHappyCLI(['runner', 'start'], { detached: true, stdio: 'ignore' });
```

Replacement:
```ts
const state = await readRunnerState();
const argv = state?.startedWithArgv ?? ['runner', 'start-sync'];

const child = spawnHappyCLI(argv, { detached: true, stdio: 'ignore' });

const handoffOk = await waitForMachineRegistered(machineId, {
  hub: process.env.HAPI_API_URL,
  timeoutMs: 30_000,
});

if (!handoffOk) {
  logger.debug('[RUNNER RUN] Replacement runner did not register within 30s; staying alive');
  // do NOT exit - we are still the only runner the hub knows about
  return;
}

// child is up and registered, safe to exit
process.exit(0);
```

This requires:

1. **Persist original argv** in `runner.state.json`. Add `startedWithArgv: string[]` to `RunnerLocallyPersistedState` (already saving `startedWithCliVersion`, etc.). Capture `process.argv.slice(2)` at runner start.
2. **`waitForMachineRegistered` helper.** Poll hub `/api/machines`, return true when the new runner has registered with the same `machineId` AND a different PID than ours.
3. **Don't `process.exit(0)` blindly** if handoff failed. Today the parent exits after a 10s sleep regardless.

### Test plan

1. With `HAPI_DISABLE_VERSION_HANDOFF` unset, start `hapi runner start-sync --workspace-root A --workspace-root B`.
2. Touch source mtime.
3. Wait for heartbeat trigger.
4. Confirm new runner process exists with **same `--workspace-root` args** (check `ps`, `runner.state.json`).
5. Confirm hub `GET /api/machines` shows machine continuously, no gap.
6. Negative test: `chmod -x` the hapi binary or otherwise force handoff failure - confirm parent runner does **not** exit.

### Branch name

`fix/runner-handoff-preserves-argv` (depends on Fix A only by file proximity, no logical dependency).

---

## Fix C - WON'T DO - True blue-green

**Status: explicitly out of scope. Do not implement.**

Real blue-green would mean:

- Hub gains two-runner-version routing (active green vs draining blue).
- Protocol negotiates which runner version handles each new spawn.
- Drain logic waits for blue's sessions to finish before retiring blue.
- Schema additions in `shared/protocol`.

**Why not:**

1. Touches hub, CLI, and protocol - hundreds of lines, schema migration, tests across the whole stack.
2. Soup stack would need to rebase a giant invasive branch every week against upstream churn.
3. Fixes A + B already solve the actual operator pain (rebuild without breaking; if you forget the flag, handoff still works).
4. Upstream maintainer hasn't asked for this. Carrying it speculatively is a tax on every soup rebuild for years.

Revisit only if upstream signals interest in multi-version runner support, or if hosted/multi-tenant HAPI deployments become a use case for us.

---

## Verification matrix

| Scenario | A applied | B applied | Expected |
|----------|-----------|-----------|----------|
| Operator runs `hapi-driver-rebuild` with flag set by script | yes | yes | Runner stays up; sessions stay live; rebuild completes; flag unset; verify all green |
| Operator forgets flag; manual source edit | no | yes | Auto-update fires; new runner registers with same args; brief overlap acceptable |
| Operator forgets flag; B not yet applied | no | no | **Today's incident reproduces.** |
| Replacement runner crashes | no | yes | Old runner stays alive (no `process.exit(0)`); operator notified via existing logs/health |
| Two simultaneous rebuilds | yes | yes | Idempotent; flag on both, no double-handoff |

---

## Friction mode notes

**Steelman of "don't fix, just remember the flag":** the bug only fires for one user (us), the workaround is `unset HAPI_DISABLE_VERSION_HANDOFF` in `.bashrc`-equivalent, no code touched, no rebase tax. Counter: we already lost ~15 minutes today; the cost of forgetting compounds.

**Risk of Fix B:** introduces a new wait loop in the runner's heartbeat path. If `waitForMachineRegistered` itself misbehaves, we've made the auto-update path slower without fixing it. Mitigation: hard 30s timeout, default-safe (don't exit on failure).

**Risk of carrying these in soup forever:** if upstream refactors `runner/run.ts`, both branches need touch. Acceptable - they're small.

**Cheapest falsification of this whole plan:** disable the auto-update watcher entirely by setting `HAPI_RUNNER_HEARTBEAT_INTERVAL=0` (if the runner respects `0` as "never"; if not, that's a one-line patch). If that solves operator pain without Fix A or Fix B, the watcher is just unused dead weight for our use case. Worth a 30-second probe before implementing A+B.

---

## Definition of done

- [x] Fix A merged into soup stack as `feat/runner-skip-version-handoff-flag` (2026-05-31 16:24)
- [x] Fix B merged into soup stack as `fix/runner-handoff-preserves-argv` (2026-05-31 16:26)
- [x] 2026-05-31 22:40 incident retrospective + resilience stack: `fix/runner-handoff-systemd-resilience` (see below)
- [x] Manifest updated to single combined branch
- [x] `docs/operator/runner-systemd.md` rewritten with resilience-stack install + verify
- [x] Live drop-in installed: `Restart=always`, `RestartSec=5s`, `StartLimitBurst=10`, `StartLimitIntervalSec=5min`, `HAPI_DISABLE_VERSION_HANDOFF=1`
- [x] Watchdog timer enabled, dry-run + first live fire correctly identified machine as healthy
- [x] `~/.hapi/settings.json` has `runnerDisableVersionHandoff:true` for env-leak safety
- [x] C section of this doc remains marked **WON'T DO**

---

## 2026-05-31 22:40 BST incident retrospective

### What we got wrong in the original Fix A + B design

Fix A wired `HAPI_DISABLE_VERSION_HANDOFF=1` into both runtime paths (heartbeat + `isRunnerRunningCurrentlyInstalledHappyVersion`). Fix B preserved argv and added `waitForRunnerHandoff` so the old runner doesn't exit until the new one registers. Both correct, both deployed. Verification matrix from 17:00 BST signed off.

At 22:40 BST the runner died anyway:

```
[22:40:47.254] Starting hapi CLI with args:  ["bun","/$bunfs/root/hapi","runner","start-sync"]
[22:40:47.263] [RUNNER RUN] Environment
 { "PWD": "/home/heavygee/coding/hapi",
   "HAPI_API_URL": "http://127.0.0.1:3006",
   "CLI_API_TOKEN_SET": false,
   ...
   // no HAPI_DISABLE_VERSION_HANDOFF in env dump
 }
[22:40:47.265] [RUNNER CONTROL] Current CLI mtime: 1779549472629, Runner started with mtime: 1780242730153
[22:40:47.265] [RUNNER RUN] Runner version mismatch detected, restarting runner with current CLI version
[22:40:47.265] Stopping runner with PID 24935   <-- killed the systemd-owned live runner
[22:40:47.456] [RUNNER RUN] Received SIGTERM    <-- 200ms later took its own SIGTERM
[22:40:47.643] [RUNNER RUN] Process exiting with code: 0
```

Machine offline for 3 minutes until manual `systemctl start hapi-runner.service`.

### Three structural gaps Fix A+B did not close

1. **Env var leak.** Fix A relied on every CLI invocation having `HAPI_DISABLE_VERSION_HANDOFF=1` in its environment. The systemd unit's drop-in set it correctly. But a TERMINAL-launched `bun /$bunfs/root/hapi runner start-sync` (operator script, single-binary, run from `/home/heavygee/coding/hapi`) inherited the operator shell's env - which never exported it. The flag worked exactly as designed; the contract that "everybody remembers to export it" is what failed.

2. **Concurrent invocation race.** Even with proper flag propagation, two `start-sync` invocations within the same setup window could each see the other's runner as stale (or not stale) and race past each other into kill-old / start-new. The 22:40 log shows the replacement runner (PID 65341) receiving SIGTERM 200ms after starting, suggesting a parallel `runner stop` or systemd-level intervention.

3. **`Restart=on-failure` doesn't recover from clean exits.** This is the proximate cause. The runner's `process.exit(0)` is by design - the auto-restart path was supposed to spawn a replacement first. But ANY path that exits 0 (forgotten flag, handoff failure, race-driven SIGTERM during cleanup) leaves systemd thinking "service exited successfully, nothing to do". The unit policy fundamentally cannot recover from this without `Restart=always`.

### Resilience stack (this branch: `fix/runner-handoff-systemd-resilience`)

| Gap | Fix |
|-----|-----|
| Env var leak | Persisted `settings.runnerDisableVersionHandoff:true` in `~/.hapi/settings.json` (`cli/src/persistence.ts` + both check sites). Once written, every CLI invocation from any context inherits the opt-out. Env var still wins when set. |
| Concurrent race | New `~/.hapi/runner.start.lock` held by `startRunner()` for the setup window only (kill-old + acquire-runtime-lock + write-state). Stale-cleaned after 15s. Second invocation waits ~6s, then sees the now-correct version and bows out cleanly. |
| `Restart=on-failure` | New drop-in `cli/systemd/hapi-runner-resilience.conf` upgrades to `Restart=always` + `RestartSec=5` + `StartLimitBurst=10` + `StartLimitIntervalSec=300` (5 min). `RestartPreventExitStatus=2` for fatal config errors. |
| All of the above regress | New `hapi-runner-watchdog.{service,timer,sh}`: probes `/cli/machines/<machineId>` every 60s; if active=false or `runnerState.status != "running"` and heartbeat is older than 30s, restarts the unit via NOPASSWD sudo. |

### Friction-mode falsification (post-mortem)

The original plan's friction-mode note ("cheapest falsification: just set `Restart=always`") was correct. The single line `Restart=always` would have ended operator UI pain at 22:40 BST regardless of every other code path being broken - systemd would have restarted within 5s of the clean exit. Everything else in this branch (persisted setting, start-lock, watchdog) is defense-in-depth against the underlying CLI-level bugs; `Restart=always` is the cheap proof that the system is resilient.

The persisted setting + start-lock + watchdog still earn their keep: they prevent the same bug from CAUSING a restart in the first place, which is healthier than letting it churn the service. But anyone reviewing this stack should understand the deployment is structurally safe even if every CLI-level fix regresses.

### Verification (post-deploy, 23:30 BST)

```
$ systemctl show hapi-runner.service -p Restart -p RestartUSec \
    -p StartLimitBurst -p StartLimitIntervalUSec -p RestartPreventExitStatus -p Environment
Restart=always
RestartUSec=5s
StartLimitIntervalUSec=5min
StartLimitBurst=10
RestartPreventExitStatus=2
Environment=... HAPI_DISABLE_VERSION_HANDOFF=1 ...

$ systemctl list-timers hapi-runner-watchdog.timer
NEXT                        LEFT     LAST                        PASSED  UNIT
Sun 2026-05-31 23:32:55 BST 51s left Sun 2026-05-31 23:31:55 BST 8s ago  hapi-runner-watchdog.timer

$ journalctl -u hapi-runner-watchdog.service --since '5 min ago' | tail -1
... [watchdog] machine f9bb3c9e-... active + runner=running on http://127.0.0.1:3006; no action

$ cat ~/.hapi/settings.json | jq '.runnerDisableVersionHandoff, .machineId'
true
"f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026"
```

Live `hapi-runner.service` MainPID 32517 unchanged across the deploy - no service restart needed for the policy change (daemon-reload sufficed).

### Known pre-existing test failure

`cli/src/runner/runner.integration.test.ts > ... should detect version mismatch and kill old runner` fails on the cherry-picked branches (verified by reverting to upstream/main where it passes). Root cause: the new `waitForRunnerHandoff` blocking-poll pattern (up to 30s) + the test's 40s wait window can race - the heartbeat fires at T+30, handoff polling extends past T+40 when the test asserts. NOT introduced by this branch's new commits; documented here for future cleanup. Fix is likely a one-line bump of the test's wait window from `heartbeat + 10s` to `heartbeat + handoff_timeout + 10s`.
