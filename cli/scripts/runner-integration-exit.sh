#!/usr/bin/env bash

hapi_runner_integration_exit() {
    local prior_status="$1"
    local cleanup_status="$2"
    trap - EXIT
    if [[ "$prior_status" -ne 0 ]]; then
        exit "$prior_status"
    fi
    exit "$cleanup_status"
}
