#!/usr/bin/env bash
# hapi-use-worktree <path-to-worktree> [--impatient]
# Swings hapi-active and restarts hub + runner together from that tree.
#
# Patient by default: waits for WORKING sessions to finish (poll every 30s)
# before tearing the hub down. Times out after HAPI_PATIENT_TIMEOUT seconds
# (default 600 = 10 min) and logs who's still WORKING before proceeding.
#
# Bypass:
#   --impatient            yank the hub immediately, kill live sessions
#   HAPI_IMPATIENT=1       same, via env (for non-interactive callers)

set -euo pipefail

IMPATIENT=0
WORKTREE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --impatient) IMPATIENT=1; shift ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        -*) echo "Unknown flag: $1" >&2; exit 2 ;;
        *)
            if [[ -z "$WORKTREE" ]]; then WORKTREE="$1"; shift
            else echo "Unexpected arg: $1" >&2; exit 2; fi
            ;;
    esac
done

[[ -n "$WORKTREE" ]] || { echo "Usage: hapi-use-worktree <path-to-worktree> [--impatient]" >&2; exit 2; }
[[ "${HAPI_IMPATIENT:-}" == "1" ]] && IMPATIENT=1

# TTY check for --impatient. See hapi-restart-hub.sh for the rationale
# (2026-06-13 incident: agent ran --impatient from tool-call shell,
# killed 8 in-flight sessions, called it a brief test). Operator at
# real terminal: tty_nr != 0 on parent. Agent shell: tty_nr=0.
# HAPI_IMPATIENT_BATCH=1 is the explicit cron/watchdog opt-in.
_caller_has_tty_for_impatient() {
    local _stat _tty_nr
    [ -r "/proc/$PPID/stat" ] || return 1
    _stat="$(cat "/proc/$PPID/stat" 2>/dev/null)" || return 1
    _tty_nr=$(printf '%s' "$_stat" | sed 's/.*) //' | awk '{print $5}')
    [ -n "$_tty_nr" ] && [ "$_tty_nr" != "0" ]
}
if [[ "$IMPATIENT" -eq 1 ]] && ! _caller_has_tty_for_impatient && [[ "${HAPI_IMPATIENT_BATCH:-}" != "1" ]]; then
    cat >&2 <<EOF

REFUSE: --impatient (or HAPI_IMPATIENT=1) requires a controlling terminal.

This script swings the live stack and kills in-flight sessions when
--impatient is set. The caller has no controlling tty.

Did you actually mean one of these?

  hapi-use-worktree $WORKTREE        patient swing (default,
                                              waits for in-flight
                                              sessions, up to 10 min)

  hapi-driver-status                          see who is in flight first

If you are an operator at a real terminal: run from there.

If you are cron/CI that legitimately needs the impatient swing from a
non-tty context: set HAPI_IMPATIENT_BATCH=1 to acknowledge.

EOF
    exit 1
fi

WORKTREE="$(realpath "$WORKTREE")"
ACTIVE_LINK="${HAPI_ACTIVE_LINK:-$HOME/coding/hapi/active}"
HUB_ENV="${HAPI_HUB_ENV:-$HOME/.hapi/hub.env}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi/driver}"
PATIENT_TIMEOUT="${HAPI_PATIENT_TIMEOUT:-600}"
PATIENT_INTERVAL="${HAPI_PATIENT_INTERVAL:-30}"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
HEALTH_SCRIPT="${HAPI_SESSIONS_HEALTH:-$SCRIPT_DIR/../hapi-sessions-health.sh}"

if [[ ! -d "$WORKTREE/hub" ]] || [[ ! -d "$WORKTREE/cli" ]]; then
    echo "ERROR: $WORKTREE must be a full HAPI worktree (hub/ + cli/)" >&2
    exit 1
fi

# Policy guard: this script swings the live stack and kills running sessions.
# It is operator-only. Two patterns trip it:
#
#   (1) Caller's PWD is at or under the target worktree. That is the agent
#       self-deletion pattern: an agent working in their own dev branch runs
#       hapi-use-worktree to test their code, swings the stack to their own
#       worktree, and the running runner kills the agent's session as soon
#       as the new hub starts. Both 2026-06-10 02:14 and 2026-06-11 14:00
#       outages followed this exact pattern.
#
#   (2) HAPI_AGENT_CONTEXT=1 is set in the env. This is forward-compat for
#       runner-side enforcement: when the runner spawns an agent's shell, it
#       sets this flag, and any tool the agent invokes from that shell
#       inherits it. Today the runner does not set it yet (see
#       docs/plans/2026-06-11-agent-context-env-flag.md). Until then this
#       branch only fires for callers who explicitly set it.
#
# Bypass is explicit and named for the situation, not a generic YES flag:
#   HAPI_USE_WORKTREE_FROM_INSIDE=1   (operator inside the target tree)
#   HAPI_USE_WORKTREE_FROM_AGENT=1    (operator-driven agent that has cause)
#
# HAPI_STACK_SWITCH_YES=1 alone does NOT bypass these guards. Per
# docs/tooling/driver-soup.md that flag exists for non-interactive operator
# scripts (cron, CI, hapi-watch-activate-driver), not for agents.
caller_pwd_inside_target() {
    local my_pwd target
    my_pwd="$(realpath "$PWD" 2>/dev/null || echo "")"
    target="$(realpath "$WORKTREE")"
    [[ -n "$my_pwd" ]] || return 1
    [[ "$my_pwd" == "$target" || "$my_pwd" == "$target/"* ]]
}

# TTY check helper: parent process has controlling terminal? Operator
# interactive shells (SSH/tmux/console bash) have non-zero tty_nr; agent
# tool-call shells have zero. Used to gate the bypass env vars below.
# See scripts/tooling/lib/operator-tty-gate.sh for full rationale.
_caller_has_tty() {
    local _stat _tty_nr
    [ -r "/proc/$PPID/stat" ] || return 1
    _stat="$(cat "/proc/$PPID/stat" 2>/dev/null)" || return 1
    _tty_nr=$(printf '%s' "$_stat" | sed 's/.*) //' | awk '{print $5}')
    [ -n "$_tty_nr" ] && [ "$_tty_nr" != "0" ]
}

if caller_pwd_inside_target && { [[ "${HAPI_USE_WORKTREE_FROM_INSIDE:-}" != "1" ]] || ! _caller_has_tty; }; then
    cat >&2 <<EOF

REFUSE: caller PWD is at or under the target worktree.
        ($(realpath "$PWD") -> $(realpath "$WORKTREE"))

This is the agent self-deletion pattern: hapi-use-worktree swings the live
stack to the target tree and restarts hub + runner. Running it from inside
your own dev worktree kills your own running session as a side effect.

Correct workflow for testing a feature branch on the live hub:

    1. Add the branch to ~/.config/hapi/driver-manifest.yaml:
         layers:
           - branch: <your-branch>
    2. hapi-driver-rebuild --build-web --verify
       (merges into driver/integration, builds, runs typecheck + tests;
        does NOT touch live hub.)
    3. Ask the operator to swing live (hapi-use-driver) when ready.

Bypass for genuine operator use from inside the target tree
(must be invoked from a real terminal - SSH, tmux, or local console;
TTY-gated since 2026-06-13 against agent tool-call abuse):
    HAPI_USE_WORKTREE_FROM_INSIDE=1 hapi-use-worktree $WORKTREE

EOF
    exit 1
fi

if [[ "${HAPI_AGENT_CONTEXT:-}" == "1" ]] && { [[ "${HAPI_USE_WORKTREE_FROM_AGENT:-}" != "1" ]] || ! _caller_has_tty; }; then
    cat >&2 <<EOF

REFUSE: HAPI_AGENT_CONTEXT=1 in environment.

This script is operator-only. Agents must add their feature branch to the
soup manifest and run hapi-driver-rebuild instead - see the inside-target
guard above for the full workflow.

Bypass for an operator-driven agent with cause (operator must run
the command from a real terminal; agent shells fail the TTY gate
added 2026-06-13 after the operator-override env vars were abused
to take down the hub from a runner-spawned cursor session):
    HAPI_USE_WORKTREE_FROM_AGENT=1 hapi-use-worktree $WORKTREE

EOF
    exit 1
fi

# Pre-flight schema check: refuse the swap if the live DB schema is ahead of
# the target tree AND we have no downgrade path. Catches the class of outage
# where someone swings to a feature branch that hasn't merged a schema-bumping
# layer yet (e.g. 2026-06-11 02:14 inline-model-error-detect: live=v10, target=v9,
# v10->v9 path exists in db-prep so OK; would refuse if path were missing).
#
# Skip with HAPI_SKIP_DB_PREP=1 (mirrors the same env used downstream).
preflight_schema_check() {
    [[ "${HAPI_SKIP_DB_PREP:-}" == "1" ]] && return 0
    local script_dir db_prep db live target
    script_dir="$(dirname "$(readlink -f "$0")")"
    db_prep="$script_dir/hapi-driver-db-prep.sh"
    db="${HAPI_DB_PATH:-$HOME/.hapi/hapi.db}"

    [[ -f "$WORKTREE/hub/src/store/index.ts" ]] || {
        echo "WARN: pre-flight: $WORKTREE/hub/src/store/index.ts missing; skipping schema check" >&2
        return 0
    }
    [[ -f "$db" ]] || {
        echo "WARN: pre-flight: $db missing; skipping schema check (fresh install?)" >&2
        return 0
    }
    [[ -x "$db_prep" ]] || {
        echo "WARN: pre-flight: $db_prep not executable; skipping schema check" >&2
        return 0
    }

    target="$(grep -oE 'SCHEMA_VERSION:\s*number\s*=\s*[0-9]+' "$WORKTREE/hub/src/store/index.ts" 2>/dev/null \
              | head -1 | grep -oE '[0-9]+$' || true)"
    live="$(sqlite3 "$db" 'PRAGMA user_version;' 2>/dev/null || true)"
    if [[ -z "$target" || -z "$live" ]]; then
        echo "WARN: pre-flight: could not parse schema versions (target=$target live=$live); skipping" >&2
        return 0
    fi

    echo "Pre-flight schema: live=$live  target=$target  ($db <-> $WORKTREE)"

    if [[ "$live" -eq "$target" ]]; then
        echo "  match - hub will boot cleanly on this tree."
    elif [[ "$live" -lt "$target" ]]; then
        echo "  forward - hub will auto-migrate $live -> $target on boot via stepMigrations."
    else
        # Downgrade required. Verify db-prep has a step for every hop.
        local cur="$live"
        while [[ "$cur" -gt "$target" ]]; do
            local prev=$((cur - 1))
            if ! grep -qE "${cur}_to_${prev}\)" "$db_prep"; then
                echo "" >&2
                echo "ERROR: live DB is at v$live but $WORKTREE expects v$target." >&2
                echo "       No known downgrade path v${cur} -> v${prev} in:" >&2
                echo "         $db_prep" >&2
                echo "" >&2
                echo "  Refusing to swap active link. Options:" >&2
                echo "    1. Roll forward: pick a worktree that owns v$live (or merge the" >&2
                echo "       schema-bumping layer into $WORKTREE)." >&2
                echo "    2. Add a v${cur} -> v${prev} downgrade case to apply_downgrade_step()" >&2
                echo "       in $db_prep and re-run." >&2
                echo "    3. Restore from a v$target backup manually (~/.hapi/hapi.db.bak.*)." >&2
                echo "" >&2
                return 1
            fi
            cur="$prev"
        done
        echo "  downgrade path exists ($live -> $target); db-prep will apply after stop."
    fi
    return 0
}

if ! preflight_schema_check; then
    exit 1
fi

# Patient drain: poll WORKING session count and wait until it reaches 0 (or
# we hit the timeout). The drain happens AFTER lock acquire (below) but
# BEFORE the systemctl stop, so a second patient caller is held by flock at
# the gate rather than draining in parallel.
patient_drain() {
    [[ "$IMPATIENT" -eq 1 ]] && { echo "patient: skipped (--impatient)"; return 0; }
    if [[ ! -x "$HEALTH_SCRIPT" ]]; then
        echo "patient: WARN $HEALTH_SCRIPT not executable -- skipping drain" >&2
        return 0
    fi
    local working start now elapsed
    working="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    [[ "$working" -eq 0 ]] && { echo "patient: WORKING=0, no drain needed"; return 0; }
    echo "patient: WORKING=$working sessions in flight; waiting up to ${PATIENT_TIMEOUT}s (poll ${PATIENT_INTERVAL}s)"
    echo "patient: bypass next time with --impatient or HAPI_IMPATIENT=1"
    start=$SECONDS
    while [[ "$working" -gt 0 ]]; do
        elapsed=$((SECONDS - start))
        if [[ "$PATIENT_TIMEOUT" -gt 0 && "$elapsed" -ge "$PATIENT_TIMEOUT" ]]; then
            echo "patient: TIMEOUT after ${elapsed}s with WORKING=$working -- proceeding anyway" >&2
            "$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '.sessions[]? | select(.status == "WORKING") | "  still WORKING: id=\(.id // "?") tag=\(.tag // "?")"' >&2 || true
            return 0
        fi
        echo "  $(date '+%H:%M:%S')  WORKING=$working  elapsed=${elapsed}s  budget=${PATIENT_TIMEOUT}s"
        sleep "$PATIENT_INTERVAL"
        working="$("$HEALTH_SCRIPT" --json 2>/dev/null | jq -r '[.sessions[]? | select(.status == "WORKING")] | length' 2>/dev/null || echo 0)"
    done
    echo "patient: WORKING=0 after $((SECONDS - start))s -- proceeding"
}

# Concurrency guard + status reporting (see lib/driver-status.sh).
# Bypassable: HAPI_SKIP_DRIVER_LOCK=1 (testing only).
LIB_DIR="$(dirname "$(readlink -f "$0")")/lib"
# shellcheck source=lib/driver-status.sh
source "$LIB_DIR/driver-status.sh"
if [[ "${HAPI_SKIP_DRIVER_LOCK:-}" != "1" ]]; then
    driver_status_init
    driver_status_acquire switch
    PREV_ACTIVE="$(readlink -f "$ACTIVE_LINK" 2>/dev/null || echo unknown)"
    driver_status_begin switch "$WORKTREE"
    driver_status_set switch "from=$PREV_ACTIVE" "to=$WORKTREE"
    trap 'driver_status_end switch "$?"' EXIT
fi

if [[ ! -e "$WORKTREE/hub/.env" ]]; then
    echo "Linking $HUB_ENV → $WORKTREE/hub/.env"
    ln -sfn "$HUB_ENV" "$WORKTREE/hub/.env"
fi

if [[ ! -d "$WORKTREE/node_modules" ]]; then
    echo "Installing dependencies in $WORKTREE ..."
    (cd "$WORKTREE" && "$BUN" install)
fi

if [[ ! -f "$WORKTREE/web/dist/index.html" ]]; then
    echo "WARNING: $WORKTREE/web/dist/index.html missing — hub UI may be stale." >&2
    if [[ -t 0 ]]; then
        read -rp "Build web now? [y/N] " yn
        if [[ "${yn,,}" == "y" ]]; then
            (cd "$WORKTREE/web" && "$BUN" run build)
        fi
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$IMPATIENT" -eq 1 ]]; then
    echo "  STACK SWITCH (IMPATIENT) — kills live agent sessions NOW"
else
    echo "  STACK SWITCH — patient drain, then restart hub + runner"
fi
echo "  Target:   $WORKTREE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ -t 0 ]]; then
    read -rp "Proceed? [y/N] " confirm
    [[ "${confirm,,}" == "y" ]] || { echo "Aborted."; exit 1; }
elif [[ "${HAPI_STACK_SWITCH_YES:-}" != "1" ]]; then
    echo "Refusing stack switch without TTY. Export HAPI_STACK_SWITCH_YES=1 to confirm." >&2
    exit 1
fi

# Drain BEFORE we touch the symlink or stop the hub. We're inside the switch
# lock; second concurrent caller is blocked at the gate, not racing the drain.
patient_drain

echo "Pointing hapi-active → $WORKTREE"
ln -sfn "$WORKTREE" "$ACTIVE_LINK"

# DB jiu-jitsu: ensure ~/.hapi/hapi.db schema matches the target tree before the
# hub starts. Skip with HAPI_SKIP_DB_PREP=1 (not recommended).
DB_PREP="$(dirname "$(readlink -f "$0")")/hapi-driver-db-prep.sh"
if [[ "${HAPI_SKIP_DB_PREP:-}" != "1" && -x "$DB_PREP" ]]; then
    echo ""
    echo "Stopping hub to prep DB ..."
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl stop hapi-hub.service || true
    if ! "$DB_PREP" "$WORKTREE"; then
        echo "ERROR: DB prep failed; refusing to restart hub on incompatible schema" >&2
        echo "       Live DB and backup are untouched if downgrade aborted." >&2
        echo "       Restart hub manually after resolving: sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl start hapi-hub.service" >&2
        exit 1
    fi
    echo ""
    echo "Starting hub + restarting runner ..."
    sudo systemctl start hapi-hub.service
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl restart hapi-runner.service
else
    if [[ "${HAPI_SKIP_DB_PREP:-}" == "1" ]]; then
        echo "WARN: HAPI_SKIP_DB_PREP=1 -- skipping DB schema check + backup" >&2
    else
        echo "WARN: hapi-driver-db-prep.sh not found at $DB_PREP -- skipping" >&2
    fi
    echo "Restarting hapi-hub.service + hapi-runner.service ..."
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl restart hapi-hub.service hapi-runner.service
fi

# Post-swap self-verification. Hub may take a few seconds to bind 3006 and
# accept auth. Runner may take a few more to register with hub. If anything
# fails to come up, swing the symlink BACK to PREV_ACTIVE and restart so the
# operator is left with a working stack instead of silent damage.
#
# Skip with HAPI_SKIP_VERIFY=1 (testing/dev only).
verify_active_stack() {
    [[ "${HAPI_SKIP_VERIFY:-}" == "1" ]] && { echo "verify: skipped (HAPI_SKIP_VERIFY=1)"; return 0; }

    local hub_url="http://127.0.0.1:3006"
    local settings="$HOME/.hapi/settings.json"
    local timeout=30 elapsed=0 step=2

    echo ""
    echo "Verifying active stack..."

    # 1) hub systemd is active and listening on 3006.
    while (( elapsed < timeout )); do
        if systemctl is-active --quiet hapi-hub.service \
           && ss -lnt 'sport = :3006' 2>/dev/null | grep -q LISTEN; then
            break
        fi
        sleep "$step"
        elapsed=$((elapsed + step))
    done
    if ! systemctl is-active --quiet hapi-hub.service; then
        echo "  FAIL: hapi-hub.service not active after ${timeout}s" >&2
        return 1
    fi
    if ! ss -lnt 'sport = :3006' 2>/dev/null | grep -q LISTEN; then
        echo "  FAIL: hub not listening on :3006 after ${timeout}s" >&2
        return 1
    fi
    echo "  hub: active + listening on :3006"

    # 2) hub responds to authenticated /api/machines.
    if [[ -f "$settings" ]] && command -v jq >/dev/null; then
        local cli token resp
        cli="$(jq -r '.cliApiToken // empty' "$settings" 2>/dev/null || true)"
        if [[ -n "$cli" ]]; then
            token="$(curl -sS --max-time 5 -H 'Content-Type: application/json' \
                -d "{\"accessToken\":\"$cli\"}" "$hub_url/api/auth" 2>/dev/null \
                | jq -r '.token // empty' 2>/dev/null || true)"
            if [[ -z "$token" ]]; then
                echo "  FAIL: hub /api/auth did not return a token" >&2
                return 1
            fi
            resp="$(curl -sS --max-time 5 -H "Authorization: Bearer $token" \
                "$hub_url/api/machines" 2>/dev/null || true)"
            if ! echo "$resp" | jq -e '.machines | type == "array"' >/dev/null 2>&1; then
                echo "  FAIL: hub /api/machines did not return expected JSON shape" >&2
                return 1
            fi
            echo "  hub: /api/auth + /api/machines OK"
        fi
    fi

    # 3) runner systemd is active.
    if ! systemctl is-active --quiet hapi-runner.service; then
        echo "  FAIL: hapi-runner.service not active" >&2
        return 1
    fi
    echo "  runner: active"

    # 4) runner registers with hub within 30s. (machineId is in settings.json
    # for this host; if absent, skip this check.)
    if [[ -f "$settings" ]] && command -v jq >/dev/null; then
        local mid cli token elapsed=0
        mid="$(jq -r '.machineId // empty' "$settings" 2>/dev/null || true)"
        cli="$(jq -r '.cliApiToken // empty' "$settings" 2>/dev/null || true)"
        if [[ -n "$mid" && -n "$cli" ]]; then
            token="$(curl -sS --max-time 5 -H 'Content-Type: application/json' \
                -d "{\"accessToken\":\"$cli\"}" "$hub_url/api/auth" 2>/dev/null \
                | jq -r '.token // empty' 2>/dev/null || true)"
            while (( elapsed < timeout )); do
                local status
                status="$(curl -sS --max-time 5 -H "Authorization: Bearer $token" \
                    "$hub_url/api/machines" 2>/dev/null \
                    | jq -r --arg mid "$mid" \
                      '.machines[]? | select(.id == $mid) | .runnerState.status // "missing"' 2>/dev/null \
                    | head -1)"
                if [[ "$status" == "running" ]]; then
                    echo "  runner: registered with hub (status=running)"
                    return 0
                fi
                sleep "$step"
                elapsed=$((elapsed + step))
            done
            echo "  FAIL: runner did not register with hub as 'running' within ${timeout}s" >&2
            return 1
        fi
    fi

    return 0
}

revert_active_stack() {
    local prev="$1"
    if [[ -z "$prev" || "$prev" == "unknown" ]] || [[ ! -d "$prev/hub" ]]; then
        echo "  cannot auto-revert: previous active not recoverable (was: $prev)" >&2
        return 1
    fi
    echo ""
    echo "Auto-reverting active link: $WORKTREE -> $prev"
    ln -sfn "$prev" "$ACTIVE_LINK"
    if [[ -x "$DB_PREP" ]]; then
        echo "  re-running db-prep against $prev (in case the failed target downgraded the DB)"
        sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl stop hapi-hub.service || true
        "$DB_PREP" "$prev" || echo "  (db-prep on revert returned non-zero; carrying on)"
    fi
    sudo HAPI_OPERATOR_SYSTEMCTL_OVERRIDE=1 systemctl restart hapi-hub.service hapi-runner.service
    sleep 4
    echo "  revert: hub=$(systemctl is-active hapi-hub.service)  runner=$(systemctl is-active hapi-runner.service)"
}

if ! verify_active_stack; then
    echo "" >&2
    echo "VERIFICATION FAILED -- attempting auto-revert" >&2
    revert_active_stack "$PREV_ACTIVE" || true
    exit 1
fi

echo ""
echo "Active stack:"
echo "  hapi-active → $(readlink -f "$ACTIVE_LINK")"
echo "  hub:    $(systemctl is-active hapi-hub.service)"
echo "  runner: $(systemctl is-active hapi-runner.service)"
systemctl show hapi-runner.service -p ExecStart --value | sed 's/^/  runner ExecStart: /'

if [[ "$WORKTREE" == "$(realpath "$DRIVER")" ]]; then
    echo "Daily driver active."
else
    echo "Restore daily driver: hapi-use-driver"
fi
