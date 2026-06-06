# PR Review Reply Helper (`hapi-pr-reply`)

`hapi-pr-reply` is the project's canonical way to respond to a PR review comment - bot or human. It posts a reply to the review thread AND resolves the thread in a single command, so the protocol-required "addressed + resolved" state is reached atomically.

> Companion piece to [`pr-review-loop.md`](./pr-review-loop.md). The loop doc covers pre-PR gating and post-push monitoring; this doc covers responding to findings.

## Why a helper exists

Two failure modes in the past:

1. **Top-level PR comments instead of thread replies.** `gh pr comment <pr> -b "fixed in <sha>"` looks like "I responded" but it silently bypasses the bot's review loop. The bot does not see top-level comments as addressing thread findings. The thread stays unresolved. The next reviewer sees "n unresolved threads" and a free-floating comment, has to manually map them, and frequently misses one. This is what caused `tiann/hapi#814` `#issuecomment-4639449666` (2026-06-06).
2. **Reply without resolve.** Posting a reply via REST but forgetting the GraphQL `resolveReviewThread` mutation. The thread is technically replied to, but it still shows as unresolved on the PR. Same downstream confusion as #1.

`hapi-pr-reply` collapses both steps so you can't do half the work.

## Usage

```bash
hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> <fix_sha> "<one-line>"
hapi-pr-reply [-R owner/repo] <pr_number> <comment_id> --skip-sha "<discussion text>"
```

- **`-R owner/repo`** - optional. Without it, uses whatever repo `gh` defaults to in the current dir (`gh repo set-default`).
- **`<pr_number>`** - the PR number on the target repo (e.g. `814`).
- **`<comment_id>`** - the **REST** review-comment id (numeric, e.g. `3367724860`), NOT the URL fragment like `#discussion_r...`. To list them:

  ```bash
  gh api repos/<owner>/<repo>/pulls/<pr>/comments \
    --jq '.[] | "\(.id) \(.path):\(.line) \(.body[:80])"'
  ```

- **`<fix_sha>`** - the commit SHA that addresses the finding (7-40 hex chars). The reply body is rendered as `Addressed in <sha>: <one-line>`.
- **`--skip-sha`** - pass this in place of a SHA when the reply is a clarification / disagreement / discussion rather than a fix. The one-line is then used verbatim.
- **`<one-line>`** - a single short sentence explaining what changed (or what you're asking). Keep it tight: this lands on the thread, not in a wiki.

## Examples

```bash
hapi-pr-reply 814 3367724860 4a03f42 "Replaced process.argv.slice(2) with getCliArgs() + defensive guard."
hapi-pr-reply -R tiann/hapi 814 3367724864 4a03f42 "New handoff protocol; parent releases lock pre-wait."
hapi-pr-reply 814 3367199612 --skip-sha "Disagree - this is intentional, see PR #770 design discussion."
```

## Behavior

1. Resolves `owner/repo` from `-R` or `gh repo view --json nameWithOwner`.
2. Validates `<pr_number>` and `<comment_id>` are numeric.
3. Validates `<fix_sha>` (or accepts `--skip-sha`).
4. Looks up the GraphQL `reviewThreads` for the PR and finds the thread whose first-comment `databaseId == <comment_id>`. Errors out clearly if the comment id doesn't belong to any review thread (common cause: you passed a top-level PR-comment id, not a review-comment id).
5. POSTs the reply via `POST /repos/{owner}/{repo}/pulls/{pr}/comments/{cid}/replies`.
6. On reply success, runs `mutation { resolveReviewThread(input: {threadId: "..."}) }`.
7. Prints the new reply URL, `isResolved=true`, and the remaining unresolved count on the PR.

Error semantics:

- Validation failures: exit 2.
- Comment id doesn't map to a review thread: exit 3 (with the listing command in the error message).
- Reply POST failed: exit 4 (does not attempt resolve).
- Reply succeeded but resolve failed: exit 5 (prints the exact graphql mutation to run manually).

## Enforcement

Two Cursor `beforeShellExecution` guards in `~/.cursor/hooks/pr-before-shell-gates.sh` reference this helper:

- `gh pr comment` / `gh issue comment` against a PR with any unresolved review threads is BLOCKED (`permission: "deny"`). The deny message tells you to use `hapi-pr-reply`. Bypass for genuine standalone comments: `HAPI_ALLOW_TOPLEVEL_COMMENT=1`.
- `git push origin <branch>` when the branch's open PR has unresolved threads is BLOCKED. Bypass for explicit mid-iteration WIP pushes: `HAPI_ALLOW_PUSH_WITH_UNRESOLVED=1`.

Bypass env-var names are deliberately ugly so they don't become muscle memory. If you find yourself reaching for them more than once a month, the threads are being treated as discardable - which is exactly the failure the guards prevent.

## Where it lives

- Script: `scripts/tooling/hapi-pr-reply.sh`
- Shim: `~/.local/bin/hapi-pr-reply` (symlink, same convention as `hapi-pr-status`).
- Protocol: `~/coding/AGENTS.local.md` §"Responding to PR review comments".
- Postmortem: `tiann/hapi#814` `#issuecomment-4639449666` (2026-06-06).
