#!/usr/bin/env bash
# build_web_preflight — refuse vite when swap is thrashing (root cause of SIGTERM ~5s builds).
# Exit 0 = OK to build; 1 = refuse with recovery hints.
build_web_preflight() {
    local max_swap_pct="${HAPI_BUILD_MAX_SWAP_USED_PCT:-85}"
    local min_avail_kib="${HAPI_BUILD_MIN_AVAIL_MEM_KIB:-2097152}" # 2 GiB

    if [[ -w /proc/sys/vm/drop_caches ]] || sudo -n true 2>/dev/null; then
        sync
        if [[ -w /proc/sys/vm/drop_caches ]]; then
            echo 1 > /proc/sys/vm/drop_caches 2>/dev/null || true
        else
            sudo -n sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches' 2>/dev/null || true
        fi
    fi

    local avail swap_used_pct swap_total
    avail="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
    read -r swap_used_pct swap_total <<<"$(free | awk '/Swap:/ { if ($2>0) printf "%d %d", ($3*100)/$2, $2; else print "0 0" }')"

    if (( swap_total > 0 && swap_used_pct > max_swap_pct )); then
        echo "ERROR: swap ${swap_used_pct}% used (max ${max_swap_pct}%) — vite builds SIGTERM under swap pressure." >&2
        echo "       Recovery (operator TTY): sync; sudo swapoff -a && sudo swapon -a" >&2
        echo "       Or wait for remote agents to drain: hapi-remote-agent-budget.sh" >&2
        echo "       Then: hapi-driver-build-web" >&2
        return 1
    fi

    if (( avail < min_avail_kib )); then
        echo "ERROR: MemAvailable $(( avail / 1024 ))MiB below $(( min_avail_kib / 1024 ))MiB floor — refuse vite build." >&2
        echo "       Try: sync; sudo sh -c 'echo 1 > /proc/sys/vm/drop_caches'" >&2
        echo "       If swap is full: sudo swapoff -a && sudo swapon -a (slow; ~3min on this host)" >&2
        return 1
    fi

    echo "build_web_preflight: OK avail=$(( avail / 1024 ))MiB swap_used=${swap_used_pct}%"
    return 0
}
