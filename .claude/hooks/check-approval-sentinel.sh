#!/bin/bash
#
# PreToolUse hook that blocks PR operations when awaiting-approval sentinel files exist.
#
# This hook prevents Claude from creating PRs or merging to main when there are
# pending user approvals required. The workflow is:
#
# 1. Implementation phase creates: claudedocs/issue-XX-awaiting-approval.md
# 2. This hook blocks PR/merge operations until user approves
# 3. User approval triggers deletion of sentinel file
# 4. PR operations are then allowed
#
# Blocked operations:
# - gh pr create
# - gh pr merge
# - Any Bash command containing these patterns
#

set -e

# Read JSON input from stdin
INPUT=$(cat)

# Extract tool name and input
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // {}')
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')

# Function to check for sentinel files
check_sentinels() {
    local sentinel_dir="$CWD/claudedocs"

    # Check if any awaiting-approval files exist
    if [ -d "$sentinel_dir" ]; then
        local sentinels=$(find "$sentinel_dir" -name "*-awaiting-approval.md" -type f 2>/dev/null)
        if [ -n "$sentinels" ]; then
            echo "$sentinels"
            return 0
        fi
    fi
    return 1
}

# Function to check if this is a PR operation
is_pr_operation() {
    local tool="$1"
    local input="$2"

    case "$tool" in
        "Bash")
            # Extract the command from tool input
            local cmd=$(echo "$input" | jq -r '.command // ""')

            # Check for PR-related gh commands
            if echo "$cmd" | grep -qE 'gh\s+pr\s+(create|merge)'; then
                return 0
            fi
            ;;
        mcp__github__create_pull_request|mcp__github__merge_pull_request)
            return 0
            ;;
    esac

    return 1
}

# Main logic
if is_pr_operation "$TOOL_NAME" "$TOOL_INPUT"; then
    SENTINELS=$(check_sentinels || true)

    if [ -n "$SENTINELS" ]; then
        # Format the list of sentinel files
        SENTINEL_LIST=$(echo "$SENTINELS" | sed 's/^/  - /')

        # Output deny decision
        cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "PR operations are BLOCKED - user approval required.\n\nSentinel file(s) found:\n$SENTINEL_LIST\n\nWorkflow:\n1. Wait for user to manually test the changes\n2. User must explicitly approve the implementation\n3. After approval, the sentinel file will be removed\n4. Then PR operations will be allowed\n\nDo NOT attempt to bypass this gate."
  }
}
EOF
        exit 0
    fi
fi

# No blocking needed - allow the operation
exit 0
