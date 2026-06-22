#!/usr/bin/env bash
# hapi-peer-stack — isolated hub + web + runner for feature peers (never touches :3006).
#
# Usage:
#   hapi-peer-stack up   [--name NAME] [--worktree PATH] [--no-runner] [--no-seed] [--no-build]
#   hapi-peer-stack down [--name NAME] [--wipe]
#   hapi-peer-stack status [--name NAME | --all]
#   hapi-peer-stack doctor [--name NAME]
#   hapi-peer-stack gc
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/peer-stack-ports.sh
source "$SCRIPT_DIR/lib/peer-stack-ports.sh"
# shellcheck source=lib/peer-stack-registry.sh
source "$SCRIPT_DIR/lib/peer-stack-registry.sh"

BUN="${BUN:-$HOME/.bun/bin/bun}"
PEER_STACK_TTL_HOURS="${HAPI_PEER_STACK_TTL_HOURS:-4}"
PEER_STACK_PRODUCTION_PORT="${PEER_STACK_PRODUCTION_PORT:-3006}"

usage() {
    sed -n '2,12p' "$0"
}

peer_stack_resolve_worktree() {
    local wt="${1:-$PWD}"
    wt="$(cd "$wt" && pwd)"
    case "$wt" in
        "$HOME"/coding/hapi/worktrees/*|"$HOME"/coding/hapi/worktrees/*/*)
            echo "$wt"
            ;;
        "$HOME"/coding/hapi-*|"$HOME"/coding/hapi/worktrees/*)
            echo "$wt"
            ;;
        *)
            echo "ERROR: worktree must be under ~/coding/hapi/worktrees/ (got $wt)" >&2
            exit 2
            ;;
    esac
}

peer_stack_default_name() {
    local wt="$1"
    basename "$wt" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-'
}

peer_stack_generate_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        "$BUN" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
    fi
}

peer_stack_wait_health() {
    local url="$1"
    local attempts="${2:-90}"
    local i=0
    while (( i < attempts )); do
        if curl -sf "$url/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    echo "ERROR: hub did not become healthy at $url/health within ${attempts}s" >&2
    return 1
}

peer_stack_stop_pid() {
    local pid="$1"
    [[ -z "$pid" ]] && return 0
    if ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    kill -TERM "$pid" 2>/dev/null || true
    local i=0
    while kill -0 "$pid" 2>/dev/null && (( i < 5 )); do
        sleep 1
        i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
    fi
}

cmd_up() {
    local name="" worktree="" no_runner=0 no_seed=0 no_build=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --name) name="${2:?}"; shift 2 ;;
            --worktree) worktree="${2:?}"; shift 2 ;;
            --no-runner) no_runner=1; shift ;;
            --no-seed) no_seed=1; shift ;;
            --no-build) no_build=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        esac
    done

    worktree="$(peer_stack_resolve_worktree "${worktree:-$PWD}")"
    [[ -n "$name" ]] || name="$(peer_stack_default_name "$worktree")"

    if (( PEER_STACK_PRODUCTION_PORT >= PEER_STACK_PORT_BASE && PEER_STACK_PRODUCTION_PORT <= PEER_STACK_PORT_MAX )); then
        echo "ERROR: production port $PEER_STACK_PRODUCTION_PORT overlaps peer stack range" >&2
        exit 2
    fi

    peer_stack_refuse_if_running "$name"

    local hub_port cli_token peer_home env_file
    hub_port="$(peer_stack_allocate_port "$PEER_STACK_REGISTRY_FILE")"
    cli_token="$(peer_stack_generate_token)"
    peer_home="$PEER_STACK_REGISTRY_DIR/$name"
    env_file="$worktree/localdocs/peer-stack.env"
    mkdir -p "$peer_home/logs" "$worktree/localdocs"

    if (( no_build == 0 )); then
        echo "==> building web in $worktree"
        (cd "$worktree" && "$BUN" install --frozen-lockfile && "$BUN" run build:web)
    fi

    echo "==> starting peer hub on 127.0.0.1:$hub_port (HAPI_HOME=$peer_home)"
    (
        export HAPI_HOME="$peer_home"
        export HAPI_LISTEN_HOST=127.0.0.1
        export HAPI_LISTEN_PORT="$hub_port"
        export CLI_API_TOKEN="$cli_token"
        export TELEGRAM_BOT_TOKEN=
        export HAPI_PUBLIC_URL="http://127.0.0.1:$hub_port"
        cd "$worktree/hub"
        nohup "$BUN" run src/index.ts >> "$peer_home/hub.log" 2>&1 &
        echo $! > "$peer_home/hub.pid"
    )

    local hub_pid
    hub_pid="$(cat "$peer_home/hub.pid")"
    peer_stack_wait_health "http://127.0.0.1:$hub_port"

    local runner_pid=""
    if (( no_runner == 0 )); then
        echo "==> starting peer runner"
        (
            export HAPI_HOME="$peer_home"
            export HAPI_API_URL="http://127.0.0.1:$hub_port"
            export CLI_API_TOKEN="$cli_token"
            cd "$worktree/cli"
            nohup "$BUN" run src/index.ts runner start-sync \
                --workspace-root "$worktree" \
                --workspace-root "$HOME/coding" \
                >> "$peer_home/runner.log" 2>&1 &
            echo $! > "$peer_home/runner.pid"
        )
        runner_pid="$(cat "$peer_home/runner.pid")"
        sleep 2
    fi

    local session_id="" web_url="http://127.0.0.1:$hub_port"
    if (( no_seed == 0 )); then
        echo "==> seeding session for Playwright"
        local seed_json
        seed_json="$("$BUN" "$SCRIPT_DIR/../dev/seed-peer-session.mjs" \
            --hub-url "$web_url" \
            --token "$cli_token" \
            --title "Peer stack $name")"
        session_id="$(echo "$seed_json" | jq -r '.sessionId')"
    fi

    cat > "$env_file" <<EOF
# Generated by hapi-peer-stack up — do not commit (gitignored)
HAPI_PEER_STACK_NAME=$name
HAPI_PEER_HUB_URL=$web_url
HAPI_PEER_WEB_URL=$web_url
HAPI_PEER_HUB_PORT=$hub_port
HAPI_PEER_HOME=$peer_home
HAPI_PEER_SESSION_ID=$session_id
HAPI_PEER_CLI_TOKEN=$cli_token
HAPI_PEER_WORKTREE=$worktree
EOF

    local started_at
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local registry_json
    registry_json="$(jq -n \
        --arg worktree "$worktree" \
        --argjson hubPort "$hub_port" \
        --arg hapiHome "$peer_home" \
        --argjson hubPid "$hub_pid" \
        --arg runnerPid "$runner_pid" \
        --arg cliApiToken "$cli_token" \
        --arg sessionId "$session_id" \
        --arg startedAt "$started_at" \
        --arg envFile "localdocs/peer-stack.env" \
        '{
            worktree: $worktree,
            hubPort: $hubPort,
            hapiHome: $hapiHome,
            hubPid: $hubPid,
            runnerPid: (if ($runnerPid | length) > 0 then ($runnerPid | tonumber?) else null end),
            cliApiToken: $cliApiToken,
            sessionId: $sessionId,
            startedAt: $startedAt,
            envFile: $envFile
        }')"
    peer_stack_registry_write_entry "$name" "$registry_json"

    echo ""
    echo "Peer stack '$name' is up"
    echo "  Hub:      $web_url"
    echo "  Session:  ${session_id:-<none — pass --no-seed>}"
    echo "  Env file: $env_file"
    echo "  Logs:     $peer_home/hub.log"
    if [[ -n "$runner_pid" ]]; then
        echo "            $peer_home/runner.log"
    fi
    echo ""
    jq -n \
        --arg name "$name" \
        --arg hubUrl "$web_url" \
        --arg sessionId "$session_id" \
        --arg envFile "$env_file" \
        '{ok:true,name:$name,hubUrl:$hubUrl,sessionId:$sessionId,envFile:$envFile}'
}

cmd_down() {
    local name="" wipe=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --name) name="${2:?}"; shift 2 ;;
            --wipe) wipe=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 2 ;;
        esac
    done
    [[ -n "$name" ]] || name="$(peer_stack_default_name "$(peer_stack_resolve_worktree "$PWD")")"

    local entry
    if ! entry="$(peer_stack_registry_read "$name" 2>/dev/null)"; then
        echo "No registry entry for '$name'" >&2
        exit 1
    fi

    local runner_pid hub_pid peer_home
    runner_pid="$(echo "$entry" | jq -r '.runnerPid // empty')"
    hub_pid="$(echo "$entry" | jq -r '.hubPid // empty')"
    peer_home="$(echo "$entry" | jq -r '.hapiHome // empty')"

    peer_stack_stop_pid "$runner_pid"
    peer_stack_stop_pid "$hub_pid"

    peer_stack_registry_remove_entry "$name"

    if (( wipe == 1 )) && [[ -n "$peer_home" ]] && [[ -d "$peer_home" ]]; then
        rm -rf "$peer_home"
        echo "Wiped $peer_home"
    fi

    echo "Peer stack '$name' stopped"
}

cmd_status() {
    local name="" all=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --name) name="${2:?}"; shift 2 ;;
            --all) all=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 2 ;;
        esac
    done

    peer_stack_registry_init

    if (( all == 1 )); then
        jq -r '.stacks // {} | to_entries[] | "\(.key)\t\(.value.hubPort)\t\(.value.worktree)\t\(.value.startedAt)"' \
            "$PEER_STACK_REGISTRY_FILE" | while IFS=$'\t' read -r n port wt started; do
            local state="stopped"
            if peer_stack_stack_running "$n"; then state="running"; fi
            printf '%-24s %-8s %-9s %s\n' "$n" "$port" "$state" "$wt (since $started)"
        done
        return 0
    fi

    [[ -n "$name" ]] || name="$(peer_stack_default_name "$(peer_stack_resolve_worktree "$PWD")")"
    local entry
    entry="$(peer_stack_registry_read "$name")"
    local state="stopped"
    if peer_stack_stack_running "$name"; then state="running"; fi
    echo "=== peer stack: $name ($state) ==="
    echo "$entry" | jq .
}

cmd_doctor() {
    local name=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --name) name="${2:?}"; shift 2 ;;
            -h|--help) usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; exit 2 ;;
        esac
    done

    peer_stack_registry_init
    local issues=0
    local now_epoch ttl_secs
    now_epoch="$(date +%s)"
    ttl_secs=$((PEER_STACK_TTL_HOURS * 3600))

    check_entry() {
        local n="$1"
        local entry hub_pid runner_pid started_at started_epoch age_secs hub_port
        entry="$(peer_stack_registry_read "$n")"
        hub_pid="$(echo "$entry" | jq -r '.hubPid // empty')"
        runner_pid="$(echo "$entry" | jq -r '.runnerPid // empty')"
        hub_port="$(echo "$entry" | jq -r '.hubPort // empty')"
        started_at="$(echo "$entry" | jq -r '.startedAt // empty')"

        if [[ -n "$hub_pid" ]] && ! peer_stack_pid_alive "$hub_pid"; then
            echo "WARN [$n] stale hubPid $hub_pid (not running)" >&2
            issues=$((issues + 1))
        fi
        if [[ -n "$runner_pid" ]] && ! peer_stack_pid_alive "$runner_pid"; then
            echo "WARN [$n] stale runnerPid $runner_pid (not running)" >&2
            issues=$((issues + 1))
        fi
        if [[ -n "$hub_port" ]] && peer_stack_port_in_use "$hub_port" && ! peer_stack_pid_alive "$hub_pid"; then
            echo "WARN [$n] port $hub_port in use but hub pid dead — possible leak" >&2
            issues=$((issues + 1))
        fi
        if [[ -n "$started_at" ]]; then
            started_epoch="$(date -d "$started_at" +%s 2>/dev/null || echo 0)"
            if (( started_epoch > 0 )); then
                age_secs=$((now_epoch - started_epoch))
                if (( age_secs > ttl_secs )); then
                    echo "WARN [$n] stack older than ${PEER_STACK_TTL_HOURS}h (started $started_at) — run hapi-peer-stack gc" >&2
                    issues=$((issues + 1))
                fi
            fi
        fi
    }

    if [[ -n "$name" ]]; then
        check_entry "$name"
    else
        while IFS= read -r n; do
            [[ -z "$n" ]] && continue
            check_entry "$n"
        done < <(peer_stack_registry_list_names)
    fi

    if (( issues == 0 )); then
        echo "peer-stack doctor: OK"
    else
        echo "peer-stack doctor: $issues issue(s) reported" >&2
        return 1
    fi
}

cmd_gc() {
    peer_stack_registry_init
    local n
    while IFS= read -r n; do
        [[ -z "$n" ]] && continue
        if ! peer_stack_stack_running "$n"; then
            echo "Removing stale registry entry: $n"
            peer_stack_registry_remove_entry "$n"
            continue
        fi
        local entry started_at started_epoch now_epoch ttl_secs age_secs
        entry="$(peer_stack_registry_read "$n")"
        started_at="$(echo "$entry" | jq -r '.startedAt // empty')"
        started_epoch="$(date -d "$started_at" +%s 2>/dev/null || echo 0)"
        now_epoch="$(date +%s)"
        ttl_secs=$((PEER_STACK_TTL_HOURS * 3600))
        if (( started_epoch > 0 )); then
            age_secs=$((now_epoch - started_epoch))
            if (( age_secs > ttl_secs )); then
                echo "TTL expired — stopping $n"
                cmd_down --name "$n"
            fi
        fi
    done < <(peer_stack_registry_list_names)
}

main() {
    local cmd="${1:-}"
    shift || true
    case "$cmd" in
        up) cmd_up "$@" ;;
        down) cmd_down "$@" ;;
        status) cmd_status "$@" ;;
        doctor) cmd_doctor "$@" ;;
        gc) cmd_gc "$@" ;;
        -h|--help|"") usage; exit 0 ;;
        *) echo "Unknown command: $cmd" >&2; usage >&2; exit 2 ;;
    esac
}

main "$@"
