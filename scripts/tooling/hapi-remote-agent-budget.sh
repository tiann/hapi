#!/usr/bin/env bash
# Pre-flight before bulk HAPI remote agent spawns.
# Exit 0 = OK; 2 = agent count over budget; 3 = memory/swap too tight.
#
# Usage:
#   hapi-remote-agent-budget.sh
#   HAPI_MAX_REMOTE_AGENTS=12 hapi-remote-agent-budget.sh
#
# Orchestrators: run this before spawning N peers; abort if non-zero.

set -euo pipefail

MAX="${HAPI_MAX_REMOTE_AGENTS:-15}"
MIN_AVAIL_KIB="${HAPI_MIN_AVAIL_MEM_KIB:-4194304}" # 4 GiB
MAX_SWAP_USED_PCT="${HAPI_MAX_SWAP_USED_PCT:-80}"

count="$(ps aux | grep -c '[b]un.*hapi.*cli.*--hapi-starting-mode remote' || true)"
avail="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
swap_used_pct="$(free | awk '/Swap:/ { if ($2>0) printf "%d", ($3*100)/$2; else print 0 }')"

if (( count >= MAX )); then
  echo "REFUSE: ${count} remote HAPI agent wrappers running (max ${MAX})" >&2
  exit 2
fi

if (( avail < MIN_AVAIL_KIB )); then
  echo "REFUSE: MemAvailable $(( avail / 1024 ))MiB below $(( MIN_AVAIL_KIB / 1024 ))MiB floor" >&2
  exit 3
fi

if (( swap_used_pct > MAX_SWAP_USED_PCT )); then
  echo "REFUSE: swap ${swap_used_pct}% used (max ${MAX_SWAP_USED_PCT}%)" >&2
  exit 3
fi

echo "OK: remote_agents=${count}/${MAX} avail_mib=$(( avail / 1024 )) swap_used_pct=${swap_used_pct}%"
exit 0
