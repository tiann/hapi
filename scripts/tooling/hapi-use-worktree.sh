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

echo "Restarting hapi-hub.service + hapi-runner.service ..."
sudo systemctl restart hapi-hub.service hapi-runner.service

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
