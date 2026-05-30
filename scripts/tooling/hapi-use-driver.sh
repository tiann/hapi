#!/usr/bin/env bash
# hapi-use-driver
# Swings hapi-hub.service to the daily-driver soup checkout.
# Same as: hapi-use-worktree ~/coding/hapi-driver

set -euo pipefail

DRIVER="${HAPI_DRIVER:-$HOME/coding/hapi-driver}"
exec hapi-use-worktree "$DRIVER"
