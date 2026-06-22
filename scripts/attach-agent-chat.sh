#!/usr/bin/env bash
# Attach a legacy agent chat UUID to HAPI (spawn, reconnect merge, optional transcript backfill).
# resumeagent-tui auto mode invokes this when present under the resolved hapi repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun run "$ROOT/scripts/tooling/attach-agent-chat.ts" "$@"
