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

The `cold-review-clean` label on a fork PR is the operator's explicit signal that the **fork-side bot pass is satisfactory** - either the bot found nothing actionable, or the operator explicitly accepts/defers what it did find. `hapi-pr-create` requires this signal (or `--skip-fork-stage`) before opening the upstream PR.

### Important: fork bot and upstream bot are TWO DIFFERENT PRODUCTS

This was misdocumented as "same vendor, different stochastic samples" until 2026-06-06. Corrected reality:

| | Fork (`heavygee/hapi`) | Upstream (`tiann/hapi`) |
|---|---|---|
| Bot login | `chatgpt-codex-connector[bot]` | `github-actions[bot]` |
| Product | **ChatGPT Codex Cloud Connector** (SaaS, configured at chatgpt.com/codex) | **`openai/codex-action@v1`** (GitHub Action) |
| Runs on | OpenAI's infrastructure, triggered by chatgpt.com integration | GitHub Actions runner using THIS repo's `OPENAI_API_KEY` secret |
| Config | Whatever the operator's ChatGPT Codex Cloud account sets (black-box from repo's POV) | `.github/workflows/codex-pr-review.yml` + `.github/prompts/codex-pr-review.md` (in-repo, version-controlled) |
| Model | Set in chatgpt.com (unknown to repo) | `gpt-5.5` via `vars.OPENAI_MODEL` (upstream config) |
| Repo access | Restricted SaaS view (line-range diff focus) | Full repo checkout (`fetch-depth: 0` of `refs/pull/N/merge`) |
| Output format | `### 💡 Codex Review` markdown | `**Findings** - [Severity] Title` per the in-repo prompt |
| Quota | Operator's ChatGPT Plus subscription | Repo's OpenAI API billing |

**Why this matters:** the workflow + prompt + AGENTS.md alignment work done on 2026-06-06 (commits `978bb7f1`, `92ade7ad`) was based on the wrong mental model. Those files are **only consumed by the upstream bot**. The fork bot uses chatgpt.com's settings and ignores those repo files entirely. The alignment work still helps - when our PRs reach upstream, upstream's bot will see the same AGENTS.md context as before - but it has near-zero effect on the fork bot.

### Why we don't have parity (and why it's accepted)

True parity would require running `openai/codex-action@v1` on `heavygee/hapi` too, which requires:

1. `OPENAI_API_KEY` secret (separate billing from ChatGPT Plus)
2. `OPENAI_BASE_URL` secret  
3. `OPENAI_MODEL = gpt-5.5` repo variable
4. Disabling the chatgpt-codex-connector for the fork (or running both)

Operator declined the OpenAI API spend (ChatGPT Plus subscription only). So **we accept "best effort with the SaaS connector locally"** as the fork-stage gate. The `Codex PR Review` and `Codex Mention Response` GitHub Actions workflows remain **enabled** on heavygee/hapi per operator preference, even though they will fail on every fork PR with `ENOENT /home/runner/.codex/<id>.json` due to the missing `OPENAI_API_KEY` secret. Side effect: fork PRs show `mergeStateStatus=UNSTABLE` even when the SaaS bot review is clean. Treat the `pr-review` check FAILURE as expected infra noise; the actual review signal is `chatgpt-codex-connector[bot]`'s review comments.

### What `cold-review-clean` actually means now

**A cold-review-clean fork PR DOES mean:**

- The ChatGPT Codex Cloud Connector found nothing actionable on this code (or operator accepts/defers what it did find)
- `test` CI checks pass on the fork
- Zero unresolved review threads on the fork PR
- The operator has explicitly signed off (label is operator-applied, not bot-auto-applied)

**It DOES NOT mean:**

- The upstream bot will say nothing on promotion. The upstream bot is a **completely different product** (`openai/codex-action@v1` with `gpt-5.5` + full repo checkout). Empirically (2026-06-06 batch of fork PRs #31 #32 #33 -> upstream #823 #825 #826): the fork-stage SaaS bot caught 8 findings (1 P1 + 7 P2). The upstream action-based bot then caught 1-3 NEW findings per PR after promotion.
- Integration collisions in files outside the diff are caught - the upstream bot has full repo checkout and may reach for impacted-but-undiffed code; the SaaS bot does not.
- The PR is merge-ready without further iteration.

**Operational implication:** budget for 1-3 upstream-bot rounds on every promoted PR. The fork-stage SaaS gate compresses what would be 3-5 upstream rounds down to 1-3 — that is the value, not zero upstream rounds. It is a **second cold read by a different reviewer**, not a parity check.

### Levers we have / don't have

| Lever | Status |
|---|---|
| Same workflow files | Aligned (SHA-identical fork ↔ upstream) - useful only if/when fork action is enabled |
| Same prompt files | Aligned (SHA-identical) - same caveat |
| Same `AGENTS.md` | Aligned (commit `978bb7f1`) - helps upstream bot when our PRs reach it; near-zero effect on fork SaaS bot |
| Same model | **NOT aligned** - upstream uses `gpt-5.5`; fork SaaS bot uses whatever ChatGPT Codex Cloud sets (likely `gpt-5.5-codex` per its UI default; possibly different) |
| Same API credentials | **NOT aligned and won't be** - operator declined OpenAI API spend |
| Same bot product | **Different products entirely** - this is the structural constraint |

If the operator ever moves to an OpenAI API plan, re-enabling `Codex PR Review` workflow on heavygee/hapi (`gh workflow enable "Codex PR Review" --repo heavygee/hapi`) plus setting `OPENAI_API_KEY`/`OPENAI_BASE_URL` secrets + `OPENAI_MODEL=gpt-5.5` variable would close the gap to true parity. Until then, the fork-stage gate is a useful but architecturally distinct second cold read.

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
