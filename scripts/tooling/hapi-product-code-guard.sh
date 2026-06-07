#!/usr/bin/env bash
# Cursor preToolUse hook: refuse direct writes to HAPI product code outside a worktree.
#
# Blocks Write/Edit/StrReplace/MultiEdit/EditNotebook when target path is in:
#   ~/coding/hapi/{cli,hub,web,shared}/...
#   ~/coding/hapi/driver/{cli,hub,web,shared}/...
# UNLESS the path is under ~/coding/hapi/worktrees/<name>/... .
#
# Operator-local tooling. NOT an upstream/contributor mandate.
#
# Bypass: export HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE=1
#
# Hook input (stdin JSON) shape varies between Cursor versions; we extract `path`
# defensively from the most likely locations.

set -uo pipefail

INPUT=$(cat)

# Extract the candidate path from any of: .input.path, .tool_input.path,
# .input.target_notebook, .tool_input.target_notebook, .path
TARGET=$(printf '%s' "$INPUT" | jq -r '
    [
      .input.path,
      .tool_input.path,
      .input.target_notebook,
      .tool_input.target_notebook,
      .path
    ]
    | map(select(. != null and . != ""))
    | first // empty
' 2>/dev/null || true)

# Tool name (best-effort)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .tool // empty' 2>/dev/null || true)

# If we cannot determine the target, fail open (allow). Other hooks/safeguards apply.
if [ -z "$TARGET" ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

# Operator override
if [ "${HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE:-0}" = "1" ]; then
    echo '{ "permission": "allow" }'
    exit 0
fi

# Resolve TARGET to absolute path (Cursor usually passes absolute, but be safe).
case "$TARGET" in
    /*) ABS="$TARGET" ;;
    *)  ABS="${PWD}/${TARGET}" ;;
esac

# Normalize redundant /./ and trailing slashes (no following symlinks - the file
# may not exist yet, e.g. Write of a brand new file).
ABS=$(printf '%s' "$ABS" | sed -e 's://*:/:g' -e 's:/\./:/:g')

HAPI_ROOT="${HAPI_ROOT_OVERRIDE:-$HOME/coding/hapi}"

# Worktree exception - allow anywhere under HAPI_ROOT/worktrees/<name>/
case "$ABS" in
    "$HAPI_ROOT"/worktrees/*)
        echo '{ "permission": "allow" }'
        exit 0
        ;;
esac

# Protected product-code globs (workspace mirror and driver runtime).
PROTECTED=0
case "$ABS" in
    "$HAPI_ROOT"/cli/src/*|"$HAPI_ROOT"/cli/test/*|"$HAPI_ROOT"/cli/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/hub/src/*|"$HAPI_ROOT"/hub/test/*|"$HAPI_ROOT"/hub/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/web/src/*|"$HAPI_ROOT"/web/test/*|"$HAPI_ROOT"/web/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/shared/src/*|"$HAPI_ROOT"/shared/test/*|"$HAPI_ROOT"/shared/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/driver/cli/src/*|"$HAPI_ROOT"/driver/cli/test/*|"$HAPI_ROOT"/driver/cli/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/driver/hub/src/*|"$HAPI_ROOT"/driver/hub/test/*|"$HAPI_ROOT"/driver/hub/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/driver/web/src/*|"$HAPI_ROOT"/driver/web/test/*|"$HAPI_ROOT"/driver/web/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/driver/shared/src/*|"$HAPI_ROOT"/driver/shared/test/*|"$HAPI_ROOT"/driver/shared/tests/*) PROTECTED=1 ;;
    "$HAPI_ROOT"/upstream/cli/src/*|"$HAPI_ROOT"/upstream/hub/src/*|"$HAPI_ROOT"/upstream/web/src/*|"$HAPI_ROOT"/upstream/shared/src/*) PROTECTED=1 ;;
esac

if [ "$PROTECTED" = "1" ]; then
    DENY_MSG=$(cat <<EOF
HAPI product-code edit BLOCKED by operator-fork policy.

Target: $ABS
Tool:   ${TOOL:-unknown}

Direct edits to HAPI product code (cli/, hub/, web/, shared/ in the workspace
mirror or driver/ runtime) must happen inside a worktree at
~/coding/hapi/worktrees/<name>/... .

Required steps before editing:
  1. Confirm a tracking issue exists (gh issue list -R heavygee/hapi or tiann/hapi).
     File one first if it does not.
  2. Create the worktree:
       hapi-worktree-create <name> --branch <fix|feat>/<slug>
     (off upstream/main for upstream PR work, off main for fork-only.)
  3. Re-issue the edit against ~/coding/hapi/worktrees/<name>/<same-relative-path>

Bypass (operator-approved emergencies only):
  export HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE=1

See ~/coding/hapi/.cursor/rules/hapi-product-code-guard.mdc for full rationale.
EOF
)
    jq -n \
        --arg msg "$DENY_MSG" \
        '{
            permission: "deny",
            agent_message: $msg,
            user_message: "Blocked: HAPI product-code edit outside a worktree. Spawn worktree+ticket first, or set HAPI_OPERATOR_PRODUCT_EDIT_OVERRIDE=1 to bypass."
        }'
    exit 0
fi

echo '{ "permission": "allow" }'
exit 0
