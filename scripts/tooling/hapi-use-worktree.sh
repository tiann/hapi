#!/usr/bin/env bash
# hapi-use-worktree <path-to-worktree>
# Swings hapi-active and restarts hub + runner together from that tree.

set -euo pipefail

WORKTREE="${1:?Usage: hapi-use-worktree <path-to-worktree>}"
WORKTREE="$(realpath "$WORKTREE")"
ACTIVE_LINK="${HAPI_ACTIVE_LINK:-$HOME/coding/hapi-active}"
HUB_ENV="${HAPI_HUB_ENV:-$HOME/.hapi/hub.env}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi-driver}"

if [[ ! -d "$WORKTREE/hub" ]] || [[ ! -d "$WORKTREE/cli" ]]; then
    echo "ERROR: $WORKTREE must be a full HAPI worktree (hub/ + cli/)" >&2
    exit 1
fi

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
echo "  STACK SWITCH — kills live agent sessions"
echo "  Restarts: hapi-hub.service + hapi-runner.service"
echo "  Target:   $WORKTREE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ -t 0 ]]; then
    read -rp "Proceed? [y/N] " confirm
    [[ "${confirm,,}" == "y" ]] || { echo "Aborted."; exit 1; }
elif [[ "${HAPI_STACK_SWITCH_YES:-}" != "1" ]]; then
    echo "Refusing stack switch without TTY. Export HAPI_STACK_SWITCH_YES=1 to confirm." >&2
    exit 1
fi

echo "Pointing hapi-active → $WORKTREE"
ln -sfn "$WORKTREE" "$ACTIVE_LINK"

# DB jiu-jitsu: ensure ~/.hapi/hapi.db schema matches the target tree before the
# hub starts. Skip with HAPI_SKIP_DB_PREP=1 (not recommended).
DB_PREP="$(dirname "$(readlink -f "$0")")/hapi-driver-db-prep.sh"
if [[ "${HAPI_SKIP_DB_PREP:-}" != "1" && -x "$DB_PREP" ]]; then
    echo ""
    echo "Stopping hub to prep DB ..."
    sudo systemctl stop hapi-hub.service || true
    if ! "$DB_PREP" "$WORKTREE"; then
        echo "ERROR: DB prep failed; refusing to restart hub on incompatible schema" >&2
        echo "       Live DB and backup are untouched if downgrade aborted." >&2
        echo "       Restart hub manually after resolving: sudo systemctl start hapi-hub.service" >&2
        exit 1
    fi
    echo ""
    echo "Starting hub + restarting runner ..."
    sudo systemctl start hapi-hub.service
    sudo systemctl restart hapi-runner.service
else
    if [[ "${HAPI_SKIP_DB_PREP:-}" == "1" ]]; then
        echo "WARN: HAPI_SKIP_DB_PREP=1 -- skipping DB schema check + backup" >&2
    else
        echo "WARN: hapi-driver-db-prep.sh not found at $DB_PREP -- skipping" >&2
    fi
    echo "Restarting hapi-hub.service + hapi-runner.service ..."
    sudo systemctl restart hapi-hub.service hapi-runner.service
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
