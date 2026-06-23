#!/usr/bin/env bash
# build_web_atomic DRIVER
# Build web/dist into dist.next, sanity-check, atomic swap to dist (prev preserved).
# Caller must set BUN (defaults to ~/.bun/bin/bun).
build_web_atomic() {
    local driver="$1"
    local bun="${BUN:-$HOME/.bun/bin/bun}"
    local web="$driver/web"
    local dist="$web/dist"
    local next="$web/dist.next"
    local prev="$web/dist.prev"

    if [[ ! -d "$web" ]]; then
        echo "ERROR: driver web dir not found: $web" >&2
        return 1
    fi

    if [[ ! -d "$driver/node_modules" ]]; then
        echo "Installing dependencies (first driver build)..."
        (cd "$driver" && "$bun" install)
    fi

    # shellcheck source=build-web-preflight.sh
    source "$(dirname "${BASH_SOURCE[0]}")/build-web-preflight.sh"
    if ! build_web_preflight; then
        return 1
    fi

    rm -rf "$next"
    if ! (cd "$web" && "$bun" x vite build --outDir dist.next); then
        echo "ERROR: vite build failed; live $dist untouched" >&2
        rm -rf "$next"
        return 1
    fi
    if [[ ! -f "$next/index.html" ]]; then
        echo "ERROR: build produced no $next/index.html; live $dist untouched" >&2
        rm -rf "$next"
        return 1
    fi
    cp "$next/index.html" "$next/404.html"

    rm -rf "$prev"
    if [[ -d "$dist" ]] && [[ ! -L "$dist" ]]; then
        mv "$dist" "$prev"
    elif [[ -L "$dist" ]]; then
        rm -f "$dist"
    fi
    mv "$next" "$dist"

    # Build metadata for dist-vs-source audits (hub ignores this file).
    local head_sha
    head_sha="$(git -C "$driver" rev-parse HEAD 2>/dev/null || echo unknown)"
    cat >"$dist/.hapi-build-meta.json" <<EOF
{"driverHead":"$head_sha","builtAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","builtBy":"build_web_atomic"}
EOF

    echo "Web bundle swapped atomically: $dist"
    echo "Previous bundle: $prev (use hapi-driver-rollback-web to restore)"
}
