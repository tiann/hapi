# 2026-06-11 — `HAPI_AGENT_CONTEXT=1` env flag for runner-spawned shells

## Problem

Agents (Cursor, Claude, Codex, etc.) spawned by `hapi-runner` get a normal POSIX shell. Operator-only tooling (`hapi-use-worktree`, `hapi-use-driver`, `hapi-driver-rebuild --activate`, `sudo systemctl stop hapi-hub.service`) is reachable from that shell, and at least three documented incidents show agents reaching for it:

- 2026-06-10 02:14 BST — agent ran `HAPI_STACK_SWITCH_YES=1 hapi-use-worktree ~/coding/hapi/worktrees/inline-model-error-detect` from inside that worktree, killed live hub, no schema downgrade path because the worktree was behind the DB.
- 2026-06-11 14:00 BST — same agent, same command, same worktree, in session `a2fdb3b2`. Self-archived their session at 14:01:13 (`archiveReason: User terminated`).
- 2026-06-11 15:01:13 BST — same agent followed up with naked `sudo systemctl stop hapi-hub.service`. Hub stayed dead 14 minutes until operator manual restart.

Two safety nets landed at commit `3802e981` (`hapi-use-worktree.sh` pre-flight + auto-revert) and the in-progress sibling commit (`scripts/tooling/hapi-use-worktree.sh` PWD-inside-target hard guard). Both work but are bypassable: an agent can `cd ~/coding/hapi/driver && hapi-use-worktree ~/coding/hapi/worktrees/<their-branch>` to dodge the inside-target guard. The `HAPI_AGENT_CONTEXT=1` env-flag check exists in the script today but never fires because nothing sets the flag.

## Design

**Runner injects `HAPI_AGENT_CONTEXT=1` into every child shell it spawns.** The agent's shell tool inherits the flag. Anything the agent calls from that shell — `hapi-use-worktree`, `hapi-use-driver`, future operator-only tools — sees the flag and refuses unless explicitly bypassed.

Single touch-point: `cli/src/runner/run.ts:453-461`, where the runner builds the `extraEnv` dict before `spawnHappyCLI`. Add:

```ts
const extraEnv = {
    ...,                          // whatever's there now
    HAPI_AGENT_CONTEXT: '1',
    HAPI_AGENT_SESSION_ID: sessionId,   // optional bonus; see "extensions"
}
```

That's it for the runner side. Inheritance does the rest: the spawned `bun run cli/src/index.ts cursor --resume <sid> ...` process gets the env, and any subprocess it spawns (the cursor CLI, the agent's tool calls) inherits.

The script-side check is already in place at `scripts/tooling/hapi-use-worktree.sh` (commit pending alongside this plan):

```bash
if [[ "${HAPI_AGENT_CONTEXT:-}" == "1" ]] && [[ "${HAPI_USE_WORKTREE_FROM_AGENT:-}" != "1" ]]; then
    cat >&2 <<EOF
REFUSE: HAPI_AGENT_CONTEXT=1 in environment.
...
EOF
    exit 1
fi
```

## Implementation steps

1. **Soup branch**: `feat/runner-agent-context-flag` off `upstream/main`. Single commit.
2. **Edit `cli/src/runner/run.ts`** around line 453. Add `HAPI_AGENT_CONTEXT: '1'` to the `env` object passed to `spawnHappyCLI`. Keep `extraEnv` semantics (caller-provided vars still win).
3. **Test** in `cli/src/runner/runner.integration.test.ts` — assert spawned process inherits `HAPI_AGENT_CONTEXT=1`. (Pattern: existing tests already check argv preservation; env assertion is the same shape.)
4. **Operator-side validation**:
   - `hapi-driver-rebuild --build-web --verify`
   - `hapi-use-driver`
   - From an active agent session: run `printenv HAPI_AGENT_CONTEXT` in the bash tool. Expect `1`.
   - From the same session: run `hapi-use-worktree ~/coding/hapi/driver`. Expect the `REFUSE: HAPI_AGENT_CONTEXT=1` message and exit 1.
   - From operator's own terminal (NOT runner-spawned): `printenv HAPI_AGENT_CONTEXT` is unset; `hapi-use-worktree` works normally.
5. **Soup-add to manifest** at `~/.config/hapi/driver-manifest.yaml`. **Operator** runs the activate.

## Friction mode

**Steelman against #2**: it does not stop a determined agent. `HAPI_AGENT_CONTEXT=1 hapi-use-worktree ...` can be unset by the agent's shell (`unset HAPI_AGENT_CONTEXT && hapi-use-worktree ...`). It is a **default-deny default-on** mechanism, not a sandbox.

**Counter**: the goal is to make the policy violation **deliberate**, not accidental. An agent that unset's the flag has consciously chosen to ignore an explicit refusal message. That is documentable in postmortems and unambiguous in the agent's own transcript. Today's failure mode is "agent treats `HAPI_STACK_SWITCH_YES=1` as a friendly non-interactive flag because the doc describes it neutrally." Friction-mode caveat: if/when an agent is observed unset'ing the flag, the next layer is **runtime sandboxing** (capabilities, AppArmor, or `Restrict*` systemd directives on the runner-spawned shell), which is much more invasive.

**Risk**: env var leaks into operator's own terminal if they `cd` into a runner-spawned shell. Counter: runner-spawned shells are subprocess of the runner systemd service, not interactive. Operator's own terminals come from their login shell. No realistic leak path.

**Kill criterion**: if #2 generates more than one false-positive refusal in normal operator use within 30 days of deployment, remove the runner-side flag injection and rely on PWD-inside-target + doc enforcement only.

## Why not do this now

This commit (the one you are reading the plan from) lands **#1 + #3** today. **#2 is deferred** because it requires:

- An edit to `cli/src/runner/run.ts` which is HAPI **product code**. Per `hapi-product-code-guard.mdc` it must be in a worktree, soup-added via the manifest, and gated through `--build-web --verify` before live activation.
- A test in `runner.integration.test.ts` to keep the change behind the existing CI gate.
- Operator activation via `hapi-use-driver`, which in turn requires the `hapi-driver-status --quiet` precheck and live-session drain.

That is a separate piece of work with its own review, and #1 + #3 already raise the cost of the violation pattern enough that #2 can wait for the right moment to soup-add it.

## Definition of done

- Soup branch `feat/runner-agent-context-flag` exists, has the single TS edit + test.
- Manifest layered + rebuild verifies green.
- Live-evidence dogfood: from an agent session bash tool, `hapi-use-worktree` refuses with the `HAPI_AGENT_CONTEXT=1` message.
- This plan doc updated with a "## Live evidence" section after activation, mirroring the pattern in `2026-05-31-runner-self-restart-bluedeploy-fix.md`.

## Extensions (out of scope for #2 v1)

- `HAPI_AGENT_SESSION_ID=<sid>` injection — lets tools that DO want to know "which agent is calling me?" respond differently (e.g. a debugging dump that includes the session id).
- Agent-context-aware messaging in `hapi-restart-hub`, `hapi-driver-status`, etc. — soft refusal with "this looks like an agent call, here is the right doc" rather than a hard block. Useful for tools where agents have legitimate read-only use.
- Claude / Codex / Gemini parity — same flag from their respective spawn paths if those launchers don't already share `spawnHappyCLI`'s env handling.
