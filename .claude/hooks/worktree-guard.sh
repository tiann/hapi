#!/bin/bash
# PreToolUse hook: blocks Write/Edit to main worktree files.
# Allows: worktree paths, /tmp/, and non-project paths.

input=$(cat)
file_path=$(echo "$input" | grep -oP '"file_path"\s*:\s*"([^"]*)"' | head -1 | sed 's/.*"file_path"\s*:\s*"//;s/"$//')

# No file_path found — allow (might be a non-file tool call)
[ -z "$file_path" ] && exit 0

# Allow /tmp/ paths
[[ "$file_path" == /tmp/* ]] && exit 0

# Allow paths outside the project
[[ "$file_path" != /home/allen/_code/hapi/* ]] && exit 0

# Allow worktree paths
[[ "$file_path" == */beads-worktrees/* ]] && exit 0

# Block direct main-tree writes
echo "BLOCK: Use a git worktree for code changes. Create one with: git worktree add .git/beads-worktrees/<branch> -b <branch>"
