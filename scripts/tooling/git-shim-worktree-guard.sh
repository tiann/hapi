#!/usr/bin/env bash
# Worktree-add guard for the ~/coding/hapi clone (canonical layout enforcer).
#
# Standalone script invoked by the ~/.local/bin/git wrapper BEFORE running
# `git worktree add`. Exits 0 = OK to proceed; exits 1 (after printing) = block.
#
# Receives `git worktree add ...` args with global flags already stripped by the
# wrapper. Args here begin with "worktree" "add" ...
#
# Bypass: HAPI_SKIP_WORKTREE_GUARD=1
#
# Tested invocation patterns the wrapper forwards here:
#   git worktree add <path>
#   git worktree add -b <branch> <path> [<commit>]
#   git worktree add -B <branch> <path> [<commit>]
#   git worktree add --detach <path> <commit>
#   git worktree add --force --no-checkout <path>
#   git -C <repo> worktree add <path>            (wrapper chdirs first; -C stripped)
#
# Repo context: enforced only when invoked inside the hapi clone (detected via
# `git rev-parse --git-common-dir`). For non-hapi repos this exits 0 immediately.
# Allow-listed targets:
#   - ${HAPI_PRIMARY}/worktrees/<anything>   (canonical bucket)
#   - ${HAPI_PRIMARY}/driver                  (reserved, already exists)
#   - ${HAPI_PRIMARY}/upstream                (reserved, already exists)
#   - paths under /tmp/ or ~/tmp/             (ephemeral fixtures)
#   - paths outside ~/coding/                  (warned but allowed)
# Block:
#   - any other path under ~/coding/ (i.e. legacy ~/coding/hapi-<name>/ pattern)

set -uo pipefail

[[ "${HAPI_SKIP_WORKTREE_GUARD:-}" == "1" ]] && exit 0

[[ "${1:-}" == "worktree" && "${2:-}" == "add" ]] || exit 0

REAL_GIT="${REAL_GIT_BIN:-/usr/bin/git}"
[[ -x "$REAL_GIT" ]] || exit 0

TOP="$("$REAL_GIT" rev-parse --show-toplevel 2>/dev/null || true)"
COMMON="$("$REAL_GIT" rev-parse --git-common-dir 2>/dev/null || true)"
[[ -z "$TOP" && -z "$COMMON" ]] && exit 0

HAPI_ROOT="${HAPI_PRIMARY:-$HOME/coding/hapi}"
HAPI_ROOT="$(cd "$HAPI_ROOT" 2>/dev/null && pwd -P || echo "$HAPI_ROOT")"

COMMON_ABS=""
if [[ -n "$COMMON" ]]; then
    COMMON_ABS="$(cd "$COMMON" 2>/dev/null && pwd -P || echo "$COMMON")"
fi

is_hapi=0
if [[ -n "$COMMON_ABS" && "$COMMON_ABS" == "$HAPI_ROOT/.git" ]]; then
    is_hapi=1
fi
if [[ "$is_hapi" -ne 1 && -n "$TOP" ]]; then
    case "$TOP" in
        "$HAPI_ROOT"|"$HAPI_ROOT"/*|"$HOME/coding/hapi-"*) is_hapi=1 ;;
    esac
fi
[[ "$is_hapi" -eq 1 ]] || exit 0

shift 2
path_arg=""
while [[ "$#" -gt 0 ]]; do
    a="$1"
    case "$a" in
        -b|-B|--reason)
            shift 2 2>/dev/null || break ;;
        --reason=*|--lock|--lock=*|--checkout|--no-checkout|--detach|--force|-f|\
        --quiet|-q|--track|--no-track|--guess-remote|--no-guess-remote|--orphan|\
        --relative-paths|--no-relative-paths|--expire|--expire=*)
            shift ;;
        --*=*|-*)
            shift ;;
        *)
            path_arg="$a"
            break ;;
    esac
done

[[ -n "$path_arg" ]] || exit 0

case "$path_arg" in
    /*)        abs="$path_arg" ;;
    "~"|"~/"*) abs="${path_arg/#~/$HOME}" ;;
    *)         abs="$(pwd -P)/$path_arg" ;;
esac
abs="$(realpath -m "$abs" 2>/dev/null || echo "$abs")"

CANON_ROOT="$HAPI_ROOT/worktrees"
CANON_DRIVER="$HAPI_ROOT/driver"
CANON_UPSTREAM="$HAPI_ROOT/upstream"

case "$abs" in
    "$CANON_ROOT"/*|"$CANON_DRIVER"|"$CANON_UPSTREAM") exit 0 ;;
    /tmp/*|"$HOME/tmp/"*) exit 0 ;;
esac

case "$abs" in
    "$HOME/coding/"*)
        cat <<EOF >&2

git: BLOCKED -- git worktree add at non-canonical path inside hapi area

  Requested:  $abs
  Canonical:  $CANON_ROOT/<name>
              $CANON_DRIVER, $CANON_UPSTREAM (reserved)

  Why: hapi worktrees must live in one predictable place so all agents and
  tooling can find them. Pre-2026-06-01 worktrees in ~/coding/hapi-<name>/
  and ~/coding/hapi-worktrees/<name>/ are LEGACY and being drained.

  Use:    hapi-worktree-create <name> --branch <branch>
  Or:     git worktree add <flags> $CANON_ROOT/<name> [<commit>]
  Bypass: HAPI_SKIP_WORKTREE_GUARD=1 git worktree add ...

  See: .cursor/rules/worktree-layout.mdc
       docs/plans/2026-06-01-hapi-folders-reorganization.md

EOF
        exit 1
        ;;
    *)
        echo "git-shim: warn -- worktree add target is outside ~/coding/: $abs" >&2
        exit 0
        ;;
esac
