# Cold PR Review Rubric

Distilled from [`.github/prompts/codex-pr-review.md`](../../.github/prompts/codex-pr-review.md). Use this for `/requesting-code-review` before **every** push to a branch with an open upstream PR — not only at `gh pr create`.

## Scope

Review the **full PR diff** against the PR base branch:

```bash
git fetch origin
git diff origin/<base>...HEAD
```

On follow-up pushes, review the full diff again. Upstream bot re-runs on the latest head; your cold read must match that scope.

## Severity levels

| Level | Meaning |
|-------|---------|
| **Blocker** | Correctness bug, security hole, data loss, broken build/CI — must fix before push |
| **Major** | Regression, missing error handling, race/lifecycle bug, inadequate tests for changed behavior |
| **Minor** | Maintainability, naming, edge case with low blast radius |
| **Nit** | Style, optional polish — note only |

Map to the review skill: Blocker/Major = Critical/Important; fix before push.

## What to check

1. **Correctness** — logic matches intent; state mutations traced through full lifecycle (connect → active → disconnect → reconnect where relevant).
2. **Security** — no secret leakage; validate untrusted input; no unsafe defaults.
3. **Regressions** — existing behavior preserved unless intentionally changed.
4. **Data loss** — persistence, sync, cache invalidation, versioned updates.
5. **Performance** — avoid obvious hot-path waste in changed code.
6. **Maintainability** — matches repo conventions (`AGENTS.md`, package READMEs, 4-space indent, strict TS).
7. **Tests** — changed behavior has coverage; note gaps as Major if behavior is non-trivial.

## Review bar (match upstream bot)

- **Findings first**, ordered by severity.
- **Evidence**: cite `path:line` from the diff.
- **No speculation** — if uncertain, say so or ask (max 4 questions).
- **Diff focus** — only flag issues on added/changed lines; use context lines to validate, not to nit unchanged code.
- **High signal** — if confidence &lt; 80%, do not report as a finding.
- **Concrete fixes** — every Blocker/Major includes a minimal suggested change.
- **No praise** — issues and risks only.

## HAPI-specific context

Monorepo: `cli/`, `hub/` (or `server/`), `web/`, `shared/`. Run verification from repo root (`bun typecheck`, `bun run test`) for touched packages.

## Output format (for your own notes)

```markdown
**Findings**
- [Blocker|Major|Minor|Nit] Title — evidence `path:line`
  Suggested fix: ...

**Summary**
- N Blocker, N Major, ...
- Ready to push: yes/no
```

## After upstream bot comments

Reply to each thread with fix SHA + one sentence. Resolve with `resolveReviewThread`. See [pr-review-loop.md](./pr-review-loop.md).
