# PR Review Loop — Pre-PR Checks, Pre-Push Cold Review, and Post-Push Monitoring

## Overview

Three forcing functions keep PR quality high:

1. **Pre-PR gate** — before `gh pr create` runs, the agent must confirm verification + cold-read review skills ran.
2. **Pre-push cold review (open PR)** — before `git push origin <branch>` when that branch has an open PR, inject mandatory `/requesting-code-review` on the full PR diff (upstream bot bar).
3. **Post-push monitor** — after every push to a branch with an open PR, wait 5 minutes for bot reviewers, then surface unresolved threads + next-push reminder.

Wired in Claude Code via `~/.claude/settings.json` and Cursor via `~/.cursor/hooks.json`. Terminal/Codex use `~/.local/bin/git` stderr wrapper.

Rubric: [cold-pr-review-rubric.md](./cold-pr-review-rubric.md)

---

## Part 1 — Pre-PR Gate

### Purpose

Agents have session familiarity with code they just wrote. This creates blind spots.
Two skills exist to counter this:

- **`/verification-before-completion`** — forces the agent to run actual verification
  commands and read the output before making any success claim. No "should work",
  no partial checks.
- **`/requesting-code-review`** — dispatches a cold-read code review subagent that
  traces every state mutation through the full lifecycle (connect → active →
  disconnect → reconnect) as if seeing the code for the first time.

Both must be run and findings addressed before a PR is filed.

### Claude Code enforcement: PreToolUse hook

In `~/.claude/settings.json`, a PreToolUse hook fires when `gh pr create` is about
to execute and injects a mandatory checklist into the model's context:

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "if": "Bash(gh pr create*)",
        "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"STOP — MANDATORY PRE-PR CHECKLIST: Before creating this PR you MUST have run /verification-before-completion (all checks passing with evidence) AND /requesting-code-review (cold diff read, all findings addressed). If you have not done BOTH, do not proceed — stop and run the skills first.\"}}'"
      }
    ]
  }
]
```

The `additionalContext` message is injected into the model's context window before
the `gh pr create` command executes, forcing a pause and checklist confirmation.

### Cursor enforcement (global, `~/.cursor/hooks.json`)

| Event | Script | Behavior |
|-------|--------|----------|
| `beforeShellExecution` | `~/.cursor/hooks/pr-before-shell-gates.sh` | On `gh pr create`: pre-PR checklist via `agent_message`. On `git push origin <branch>` with open PR: cold-review STOP via `agent_message`. |
| `postToolUse` (matcher: `Shell`, timeout: 360s) | `~/.cursor/hooks/pr-post-push-check.sh` | After push: 5 min bot poll + unresolved threads + next-push reminder via `additional_context` |

Shared logic: `~/.local/bin/pr-open-push-lib.sh` (branch/PR lookup, cold-review message), `~/.local/bin/pr-post-push-check-core.sh` (post-push poll).

Policy: `~/coding/AGENTS.local.md` (all agents). Wrappers: `~/.local/bin/gh` (pre-PR create), `~/.local/bin/git` (open-PR push stderr reminder).

**Cursor CLI / HAPI headless `agent`:** `beforeShellExecution` may not fire in `--output-format stream-json` sessions. Use `~/.local/bin/git` + AGENTS.local + manual cold review until hook parity lands.

---

## Part 2 — Pre-Push Cold Review (Open PR)

### Purpose

Upstream HAPI Bot re-reviews the **full PR diff** on every push. Session familiarity after your last push creates blind spots. Before each `git push origin` on a branch with an open PR:

1. `/requesting-code-review` on `origin/<base>...HEAD` ([rubric](./cold-pr-review-rubric.md))
2. `/verification-before-completion` on touched packages
3. Fix Blocker/Major before push

### Claude Code: PreToolUse on `git push origin*`

`~/.local/bin/pr-git-push-prehook-claude.sh` reads tool input, looks up open PR for branch, injects `additionalContext` STOP block.

### Cursor: `beforeShellExecution`

Same message via `agent_message` in `pr-before-shell-gates.sh`.

### Terminal / Codex

`~/.local/bin/git` prints the STOP block to stderr (non-blocking). Codex has no user-level PreToolUse hook — AGENTS.local + wrapper are the contract.

---

## Part 3 — Post-Push Comment Monitor

### Purpose

After pushing to a branch with an open PR, wait 5 minutes for bot reviewers to process
the new commits, then surface any unresolved threads and latest comments so the agent
sees them automatically without being asked.

### Claude Code Implementation

Claude Code supports **PostToolUse hooks** — shell commands that run after a tool
executes, with the ability to inject text into the model's context via JSON output.

#### Hook script: `~/.local/bin/pr-post-push-check`

```bash
#!/usr/bin/env bash
# PostToolUse hook: after git push to a branch with an open PR, wait 5 minutes
# then check for unresolved review threads and new comments.
# Outputs additionalContext JSON so Claude sees the results automatically.

set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only trigger on git push to origin
[[ "$cmd" =~ ^git\ push\ origin ]] || exit 0

# Extract branch (last token after 'origin')
branch=$(echo "$cmd" | sed 's/.*origin[[:space:]]*//' | awk '{print $1}')
[ -z "$branch" ] && exit 0

# Find open PR for this branch
pr=$(gh pr list --head "$branch" --json number --jq '.[0].number' 2>/dev/null || true)
[ -z "$pr" ] || [ "$pr" = "null" ] && exit 0

echo "⏳ PR #$pr detected — waiting 5 minutes for bot review before checking comments..." >&2
sleep 300

# Count unresolved threads
owner_repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
owner=$(echo "$owner_repo" | cut -d/ -f1)
repo=$(echo "$owner_repo" | cut -d/ -f2)

unresolved_count=$(gh api graphql -f query="{
  repository(owner:\"$owner\", name:\"$repo\") {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes { id isResolved }
      }
    }
  }
}" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>/dev/null || echo "?")

# Grab latest comments (last 40 lines)
latest=$(gh pr view "$pr" --comments 2>/dev/null | tail -40 || echo "(could not fetch comments)")

jq -n \
  --arg ctx "5-minute post-push check on PR #$pr: $unresolved_count unresolved thread(s).

UNRESOLVED THREADS: $unresolved_count — reply and resolve any findings before proceeding.

Latest comments:
$latest" \
  '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
```

#### Hook wiring: `~/.claude/settings.json`

Add to the `hooks` object:

```json
"PostToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "cat | /home/heavygee/.local/bin/pr-post-push-check",
        "timeout": 360,
        "statusMessage": "Waiting 5 min for bot review on PR..."
      }
    ]
  }
]
```

The hook receives the full tool input on stdin as JSON:
```json
{ "tool_name": "Bash", "tool_input": { "command": "git push origin feat/my-branch" } }
```

The script filters on the command string, so non-push Bash commands exit 0 immediately
with no output.

`additionalContext` is injected into the model's next context window automatically —
Claude will see the unresolved thread count and comments without any user prompt.

---

### Manual fallback (no hook / CI-only)

If hooks are disabled, run the shared poll directly:
```bash
~/.local/bin/pr-post-push-check-core.sh <branch>
```

---

---

## What to do with findings

When the hook reports unresolved threads:

1. Read each finding carefully.
2. Make the code fix (new commit) -- or, if pushing back, prepare a one-line technical reason.
3. **Reply AND resolve in one step via the helper** (see [pr-reply.md](./pr-reply.md)):
   ```bash
   hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> <fix_sha> "<one-line>"
   # discussion / disagreement instead of a fix:
   hapi-pr-reply <pr_number> <comment_id> --skip-sha "<technical reason>"
   ```
   `hapi-pr-reply` posts the REST reply and immediately calls `resolveReviewThread`. On any failure it aborts before resolving so you never leave drift.
4. Push again (which will trigger a new 5-minute wait).

**Rule:** A finding is not done until it is replied to AND resolved. Unresolved threads signal to maintainers that the issue is still open.

**NEVER respond via `gh pr comment` (top-level PR comments).** Top-level comments silently bypass the bot's review loop, do not mark threads as addressed, and obscure the conversation surface for the next reviewer. This is enforced by `~/.cursor/hooks/pr-before-shell-gates.sh`:

- `gh pr comment <pr>` / `gh issue comment <pr>` against a PR with any unresolved review threads -> `permission: "deny"`. Bypass for genuine standalone comments (release notes, scope-change summary, NOT review responses): `HAPI_ALLOW_TOPLEVEL_COMMENT=1`.
- `git push origin <branch>` when the branch's open PR has any unresolved threads -> `permission: "deny"`. Bypass for explicit mid-iteration WIP pushes: `HAPI_ALLOW_PUSH_WITH_UNRESOLVED=1`. Reply first with a "WIP: will address in next push" note (via `hapi-pr-reply --skip-sha`) before reaching for the bypass.

Bypass env-var names are deliberately ugly so they don't become muscle memory. Postmortem: `tiann/hapi#814` `#issuecomment-4639449666` (2026-06-06) - the orchestrator created a top-level comment instead of replying to the bot's review threads, hence these guards.

---

## What `cold-review-clean` means (and what it doesn't)

The `cold-review-clean` label on a fork PR is the operator's explicit signal that the **fork-side Codex pass is satisfactory** - either Codex found nothing actionable in a single pass, or the operator explicitly accepts/defers what it did find. `hapi-pr-create` requires this signal (or `--skip-fork-stage`) before opening the upstream PR.

**It is a polishing room, not a merge-ready certifier.** Empirically (data from 2026-06-06 batch of fix/cursor-wrapper-requeue, feat/hub-session-reopen, fix/preserve-cursor-session-id): the fork-stage gate caught 8 findings across 3 PRs (1 P1 + 7 P2) that would otherwise have hit upstream. Every one of those PRs still drew 1-3 NEW findings from the upstream bot after promotion.

**Why the fork bot and the upstream bot find different things** even though both are ChatGPT Codex Connector reviewing the same code:

| Cause | Fixable? | Cost |
|---|---|---|
| **Stochastic LLM sampling** - same model + same prompt + two runs surface different finding subsets | No, fundamentally | ~2x credits to run N=2 passes and merge |
| **Different RAG repo-context** - each repo's review pulls open issues, README, AGENTS.md, recent PRs into the prompt; `heavygee/hapi` and `tiann/hapi` have different summaries so the bot's "what does this codebase care about" framing differs | Partially - mirror repo metadata across fork and upstream | Ongoing maintenance |
| **Codex Cloud config drift** - each repo has its own `.codex/` settings and review-prompt template; `tiann/hapi`'s template may emphasize "check for collision with intentional-clear paths" more than the fork's | Yes - clone upstream's config | One-time setup |
| **Diff scope rendering** - bot reviews the PR diff plus a small context window of impacted callers; the collision-relevant code may be outside the changed-file set and require the bot to reach for it (which is non-deterministic) | Partially - enable expanded-context-window if Codex Cloud exposes the knob | Per-PR cost |

**So a cold-review-clean fork PR DOES mean:**

- One Codex pass found nothing actionable on this code in isolation against `heavygee/hapi:main`
- CI (`test`, etc.) is green on the fork
- Zero unresolved review threads on the fork PR
- The operator has explicitly signed off (label is operator-applied, not bot-auto-applied)

**It DOES NOT mean:**

- The upstream bot will say nothing on promotion - expect 1-3 new findings per PR, fix them via `hapi-pr-reply` and push
- Integration collisions with files outside the diff have been caught - the upstream bot is more likely to see those because its RAG sees the full `tiann/hapi` repo context
- The PR is merge-ready without further iteration

**Operational implication:** budget for 1-3 upstream-bot rounds on every promoted PR. The fork gate compresses what would be 3-5 upstream rounds down to 1-3 - that is the value, not zero upstream rounds.

If you want fewer upstream surprises, the cheapest lever is to run N=2 fork passes (manually re-trigger Codex Cloud on the fork PR after a fresh push, even a trivial whitespace one, and treat the union of both passes as the bar). That ~2x credit cost catches more stochastic findings without changing the structural model.

---

## Finding thread / comment IDs

`hapi-pr-reply` looks up the GraphQL thread id from the REST comment id internally. To list candidate review-comment ids for a PR:

```bash
gh api repos/<owner>/<repo>/pulls/<pr>/comments \
  --jq '.[] | "\(.id) \(.path):\(.line) \(.user.login) \(.body[:80])"'
```

Lower-level GraphQL (only needed if the helper is unavailable):

```bash
gh api graphql -f query='{
  repository(owner:"tiann",name:"hapi") {
    pullRequest(number: 692) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId body }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved == false)
  | {threadId: .id, commentId: .comments.nodes[0].databaseId, body: .comments.nodes[0].body[:80]}'
```
