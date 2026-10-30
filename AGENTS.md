# AGENTS.md

HAPI is a local-first platform for running coding agents with remote control via web/phone.
CLI wraps agents → hub (Socket.IO) → web/native clients (REST + SSE).

## Task boundaries

- Complete the requested deliverable and relevant verification; do not stop at the first implementation unless the user requested a review checkpoint.
- Fix causes within the task's scope. Report unrelated problems rather than turning them into refactors or additional features.
- Make reasonable, reversible choices and continue. Ask when missing information materially affects correctness, an action needs additional authorization, or progress requires overwriting someone else's changes. Continue unaffected work.
- Preserve existing user/agent changes. Editing or generating files does not imply permission to commit, push, or release.
- Keep communication concise and clear; report results, checks performed, and remaining limitations.

## Find context when needed

Start with the task's files; read only relevant sections of these references, not a fixed sequence of READMEs.

| Task area | Entry points |
|-----------|--------------|
| Product, setup, supported agents | [README.md](README.md), [agent guide](docs/guide/agents.md) |
| Agent wrappers, CLI commands, runner | [cli/README.md](cli/README.md); for bootstrap/handoff changes, [session lifecycle invariants](cli/README.md#session-lifecycle-invariants) |
| Hub APIs, auth, sync, notifications | [hub/README.md](hub/README.md) |
| Web routes, components, data fetching | [web/README.md](web/README.md); for optional feature discovery, [FUE](web/README.md#first-user-experience-fue) |
| Shared wire types and validation | `shared/src/types.ts`, `schemas.ts`, `socket.ts`, `modes.ts` |
| Native API contract, chat conformance | [client contract](docs/api/client-contract/index.md), [iOS](ios/README.md), [Android](android/README.md) |
| Encrypted native push relay | [relay/README.md](relay/README.md) |
| User docs / marketing site | `docs/` (VitePress) / `website/` |

## Repository conventions

- Bun workspaces: `cli`, `shared`, `hub`, `web`, `website`, `docs`, `relay`. Run workspace scripts from the root; package-scoped commands may use `bun run --cwd <package> ...` or that package's directory. iOS and Android use separate toolchains.
- TypeScript strict; keep code typed. Prefer 4-space indentation. `@/*` resolves to a package's `src/*`.
- Shared protocol is `@hapi/protocol`; runtime schemas live in `shared/src/schemas.ts` (Zod).
- No backward compatibility required for formats changed by the task; do not add compatibility layers or change unrelated formats.

## Cross-component invariants

- CLI↔hub uses Socket.IO `/cli` with the CLI access token. Web terminals use `/terminal` with a client JWT; ordinary web/native updates use REST + SSE. Preserve namespace isolation (`CLI_API_TOKEN:<namespace>`).
- Metadata/state updates are versioned; preserve stale-update rejection. Permission controls use per-flavor catalogs in `shared/src/modes.ts`, further constrained by session capabilities.
- `shared/fixtures/**` is generated from the web chat pipeline, the source of truth for native conformance. Never hand-edit fixtures. For changes to fixture inputs or generation (paths in [.github/workflows/fixtures.yml](.github/workflows/fixtures.yml)), run `bun run gen:fixtures` and include any generated changes in the deliverable. CI checks drift and runs native conformance on fixture changes.

## Verification and completion

Choose checks by the change's impact, not by the number of workflow steps:

| Change | Verification |
|--------|--------------|
| Documentation only | Check edited content, local links, and diff; no code test suite. |
| Package-local code | Relevant tests and the package's typecheck where available; add regression coverage when needed. |
| Shared contracts, dependencies, broad cross-package behavior | `bun typecheck && bun run test`, plus affected integration/conformance checks. |
| Native code | Relevant checks from the iOS/Android README using available toolchains. |

- Root scripts: `bun run test:<package>` for `cli`, `hub`, `web`, `shared`, `relay`; `bun run typecheck:<package>` for `cli`, `hub`, `web`, `relay`. Shared types are checked through consumers. CLI/web tests use Vitest; hub/shared/relay use Bun test. Use file filters for focused runs.
- Within existing permissions, run and retry relevant local checks without asking at each step. Fix failures caused by the task; report unrelated failures. If tools or permissions are unavailable, complete other work and state what remains unverified; do not bootstrap native toolchains or wait on CI unless the task requires it.
- Reuse passing checks when code, dependencies, and environment are unchanged; commit/push/PR transitions alone do not require reruns. Run repository-wide checks when explicitly requested as well.
- Review this task's changes for correctness, security, and regressions. For local work, inspect unstaged/staged diffs (`git diff`, `git diff --cached`) and new files; for a branch/PR review, use the actual target branch's merge-base diff. Local self-review does not require a GitHub event, remote review, or posting comments.

## PR follow-through: review wait + auto-fix loop (agents)

Opening or updating a PR does **not** end the task. Enter a bounded review-wait phase and watch, for the current HEAD: GitHub Checks, PR reviews, plain comments, and inline review comments.

- **Entry condition.** This loop runs only inside a task that already authorizes PR follow-through (the user asked to open/update the PR and expects it carried to a merge-ready or explicitly blocked state). It does not override the authorization boundaries and CI-wait exemptions in *Task boundaries* and *Verification and completion*: waiting here is required, not the "do not wait on CI" case, because the deliverable is the reviewed PR itself; anything still needing fresh authorization (force-push, new dependencies, production data, ...) goes to "Stop and ask first".

- **One window per HEAD.** Each wait round targets the current HEAD: max 30 minutes, poll every 60s. Prefer a quiet Shell/`gh` polling loop that prints only on state change, new feedback, failure, or timeout — do not re-run full model reasoning every minute, and do not repeat identical output. After an auto-fix is pushed to the same PR branch, restart a fresh wait round from the new HEAD; never cram every round of a task into one 30-minute window.
- **Coverage.** `gh pr checks --watch` covers checks only; it does not replace reviews/comments polling. Also watch new reviews, issue comments, and review comments. Baseline against the current PR, the current HEAD commit, and the feedback already present when the round started: the baseline records which items were already handled or explicitly rejected (so stale comments are not reprocessed), but unresolved feedback present at round start stays in scope — it is carried forward, not silently dropped.
- **Auto-fix.** For clear, local feedback that does not change the agreed requirements: verify the point, implement the minimal fix, run scope-matched tests, inspect the diff, commit, and push to the same PR branch, then wait for the next round on the new HEAD. No need to ask the user for each such fix.
- **Loop bound.** At most 100 consecutive auto-fix rounds (one round = one fix-and-push for a tip review point). Stop and report when the cap is hit, when the same blocker survives 100 materially different attempts, or when a wait window ends with no checks/review results — report the current HEAD, feedback handled, items still pending or failing, and the suggested next step. A single-round timeout ends only that wait; never keep editing code with no new feedback just to reach 100 rounds.
- **Stop and ask first.** Do not auto-edit or push when feedback would change product behavior or the original requirements; when several mutually exclusive options would materially change the outcome; when the PR scope must grow; when dependencies, migrations, or architecture changes are involved; when security, credentials, or production are involved; when force-push, history rewrite, or closing/replacing the PR is needed; or when feedback conflicts with user instructions or the PR's stated goal.
- **Bots can be wrong.** Verify against the code, tests, and original requirements before fixing. Do not change code just to silence the bot on a point that does not hold — provide evidence and, when useful, a concise reply.
- **No context burn.** Waiting must not consume context with high-frequency output. Sleep/blocking waits need no model reasoning; hand the model only the minimum necessary information, and only after a state change. If the machine sleeps, the network drops, the GitHub API rate-limits, auth expires, or a tool times out, say so honestly — never claim the wait finished or the checks passed.
- **Contributor-side done.** At minimum: required checks for the current HEAD pass; the latest actionable review feedback is handled or explicitly rejected with reasons; and no verification that should have been re-run after the last fix was skipped. Do not merge into upstream `main` by default (contributors usually lack permission) — report readiness and let the maintainer merge. Merge only when the user explicitly asks and the current account really has write access to the target repo.
