#!/usr/bin/env bash
# Compile-verify and test HapiKit's Linux-buildable targets (HapiProtocol +
# HapiClient and their test targets) inside a Swift Linux container, without
# a Mac. HapiUI (SwiftUI + swift-markdown + Highlightr) is excluded: the
# Package.swift drops the UI product/targets under `#if os(Linux)`, and this
# script additionally leaves the HapiUI sources out of the staging copy.
#
# Usage:
#   ios/scripts/linux-test.sh                 # full `swift test`
#   ios/scripts/linux-test.sh --filter Chat   # any extra args go to swift test
#
# Environment:
#   HAPI_SWIFT_IMAGE   docker image (default swift:6.1-noble)
#   HAPI_LINUX_STAGE   staging dir (default: stable per-checkout dir in /tmp,
#                      kept across runs so the container's .build cache and
#                      resolved deps survive and re-runs are incremental)
#
# How it works: the package is rsynced into $STAGE/ios/Packages/HapiKit and
# the golden fixtures into $STAGE/shared/fixtures — replicating repo depth so
# the tests' `#filePath`-relative `../../../shared/fixtures` resolution works
# inside the container ($STAGE is mounted at /work). Fixes must be applied to
# the REAL worktree files; every run re-stages, so the loop is:
# edit real files -> run this script -> repeat.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$REPO_ROOT/ios/Packages/HapiKit"
FIXTURES="$REPO_ROOT/shared/fixtures"

IMAGE="${HAPI_SWIFT_IMAGE:-swift:6.1-noble}"
STAGE="${HAPI_LINUX_STAGE:-${TMPDIR:-/tmp}/hapikit-linux-test-$(printf %s "$REPO_ROOT" | cksum | cut -d' ' -f1)}"

mkdir -p "$STAGE/ios/Packages/HapiKit" "$STAGE/shared/fixtures"

# --delete keeps the stage exact but (without --delete-excluded) leaves the
# excluded .build in place, preserving incremental builds across runs.
rsync -a --delete \
  --exclude '.build' \
  --exclude 'Sources/HapiUI' \
  --exclude 'Tests/HapiUITests' \
  "$PKG/" "$STAGE/ios/Packages/HapiKit/"
rsync -a --delete "$FIXTURES/" "$STAGE/shared/fixtures/"

exec docker run --rm \
  -v "$STAGE":/work \
  -w /work/ios/Packages/HapiKit \
  "$IMAGE" \
  swift test "$@"
