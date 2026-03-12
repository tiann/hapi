# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:
- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary | Common Issues |
|----------|---------------|
| API ↔ Service | Type mismatches, missing fields |
| Service ↔ Database | Format conversions, null handling |
| Backend ↔ Frontend | Serialization, date formats |
| Component ↔ Component | Props shape changes |

### Step 3: Define Contracts

For each boundary:
- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:
- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip


## Slash Command Contract Checklist (CLI ↔ Hub ↔ Web)

When changing slash command discovery, verify:
- [ ] CLI function signature and handler wiring carry project directory context
- [ ] Hub response type includes all `source` variants used by CLI
- [ ] Web type union and filtering logic include the same `source` values
- [ ] Nested command paths are explicitly mapped to command names (e.g., `group/file.md` -> `group:file`)
- [ ] Integration check confirms `/api/sessions/:id/slash-commands` returns project commands

Reference executable contract:
- `backend/quality-guidelines.md` → `Scenario: Slash Command Cross-Layer Contract (Project + Nested)`

## Post-Merge Conflict Contract Checklist (YAML Workflow ↔ Runtime Lifecycle)

When resolving merge conflicts across infra/runtime files, verify the merged result at the contract level instead of only removing conflict markers:
- [ ] For GitHub Actions YAML, do all `needs:` references still point to real jobs after the merge?
- [ ] For publish workflows, are smoke/validation steps still ordered before any irreversible artifact push?
- [ ] For smoke steps, are you validating explicitly prepared candidate images (`--no-build` / injected image tags) rather than rebuilding a fresh local image inside the smoke job?
- [ ] For runtime availability helpers, did any merged boolean branch collapse `running` / `degraded` / `stale` semantics back into a single `false` path?
- [ ] For helper changes that answer "healthy and reusable now", did you replay every caller that may skip startup, reuse a process, or suppress recovery work?
- [ ] After conflict resolution, did you replay the relevant caller chain (`helper -> caller -> side effect`) rather than checking only the edited file?
- [ ] Is there at least one regression test or static validation that would fail if the merged contract regresses again?

Typical failure pattern:
- A merge keeps both sides syntactically valid, but changes the contract meaning:
  - YAML keeps all steps yet points `needs` to a removed job.
  - Publish flow keeps smoke test logic but moves it after `push: true`.
  - Availability helper keeps explicit states locally, but caller still interprets the merged return value as "restart now".

Reference executable contracts:
- `backend/quality-guidelines.md` → `Scenario: Post-Merge Conflict Resolution Contract (Workflow Dependencies + Runtime Availability)`

---


When UI state is cached across renders (e.g. `useRef`, query fallback, optimistic state):
- [ ] Is cache keyed/scoped by stable identity (`session.id`, `workspaceId`, etc.)?
- [ ] On identity change, do we reset previous identity cache before deriving fallback UI?
- [ ] Does fallback logic prevent previous entity errors/status from leaking into the current entity?
- [ ] Is loading/error tri-state evaluated after scope reset?
- [ ] Is there an integration test that covers "create new entity -> initial load -> no old cache leak"?

Typical failure pattern:
- Previous session status (`Git unavailable` or stale branch counters) remains in ref fallback while new session query is still loading.
- User sees wrong status until route remount/re-entry forces state reset.

---

## GitHub Review Trigger Checklist (Branch Push ↔ PR Event Workflow)

When a commit is pushed to an open PR branch but review automation (for example `Codex PR Review`) does not appear to rerun:
- [ ] Did the branch ref actually advance? Verify with `git ls-remote origin refs/heads/<branch>` instead of relying only on PR UI/`gh pr view`.
- [ ] Did push-triggered workflows run for the new SHA while `pull_request` / `pull_request_target` workflows did not?
- [ ] Is the review workflow triggered by PR events (`pull_request` / `pull_request_target`) rather than by `push`?
- [ ] Are workflow-level filters (`types`, branch filters, labels, draft gating, bot gating) satisfied for the new event?
- [ ] Did you compare workflow-run history directly (`gh run list`, workflow-specific runs API) instead of inferring from status rollups?
- [ ] Before concluding "review did not run", did you distinguish branch SHA freshness from PR metadata freshness (`headRefOid`, review aggregation, status rollup)?

Typical failure pattern:
- `git push` succeeds and branch-level `push` workflows start immediately.
- Reviewer checks `gh pr view` or PR comments, still sees the previous `headRefOid` and previous bot review.
- Team misdiagnoses the issue as "push didn't happen" or "review bot failed", when the actual problem is PR-event workflow lag / non-trigger.

Reference executable contract:
- `backend/quality-guidelines.md` → `Scenario: GitHub PR Review Trigger Contract (Push SHA vs pull_request_target Review)`

---

## Session-Switch Draft Persistence Checklist (Composer ↔ Session Identity)

When chat composer text should survive switching between sessions:
- [ ] Is draft state keyed by `session.id` rather than a single global composer value?
- [ ] On session switch, do we hydrate input from the target session draft before rendering interactive input?
- [ ] Does send success clear only the active session draft key?
- [ ] Are drafts isolated between sessions (A draft never appears in B)?
- [ ] Is there an integration test for: `type in A -> switch B -> switch A -> draft restored`?

Typical failure pattern:
- Composer relies on one shared `composer.text` state with no per-session scoping.
- Navigating away and back remounts/syncs with empty state, causing unsent input loss.

---

## Terminal Session Contract Checklist (Web ↔ Hub ↔ CLI)
When wiring terminal sessions across layers:
- [ ] Is `terminalId` scoped per session (no reuse across sessions in the same UI lifecycle)?
- [ ] Does the Web client reset cached `terminalId` on session change before reconnecting?
- [ ] Does the Hub remove registry entries on **both** web socket disconnect and CLI socket disconnect?
- [ ] Is duplicate `terminalId` creation handled as idempotent or surfaced with a clear error?
- [ ] Are platform constraints (e.g. Windows terminal unsupported) surfaced consistently to the UI?
- [ ] Is there an integration test covering "reconnect then reopen terminal" without ID collisions?

Typical failure pattern:
- A stale `terminalId` remains registered in the Hub after a disconnect, so the next connect returns
  "Terminal ID is already in use" even though the UI thinks it is a new session.

---

## Terminal Copy/Interrupt Input Contract Checklist (Web Keybinding ↔ Browser Clipboard ↔ PTY)

When terminal input includes `Ctrl+C`, `Enter`, selection copy, and clipboard fallback:
- [ ] Is there a deterministic decision order for `Ctrl+C`? (`hasSelection` copy > otherwise send `\u0003` interrupt)
- [ ] Does copy behavior avoid forwarding input bytes to PTY in the same key path?
- [ ] If copy branch is taken, does the handler explicitly `preventDefault`/`stopPropagation` to avoid accidental newline/command submit side effects?
- [ ] Are browser-unsupported clipboard paths covered by a fallback (manual copy dialog or explicit user hint)?
- [ ] Are keybinding rules documented for platform differences (`Ctrl+C` on Windows/Linux, `Cmd+C` on macOS)?
- [ ] Is there an integration test for `select text -> copy -> shell receives no ^C/\n`?

Typical failure pattern:
- Frontend forwards `Ctrl+C` directly through terminal `onData` to backend PTY (`\u0003`) even while user intent is copy.
- Result: copy fails and the active command is interrupted (or appears as unexpected enter/newline behavior).

---

## Independent Mainline Migration Checklist

When switching from upstream-collaboration mode to independent development mode:
- [ ] Is `main` merged/rebased with intended source branch before changing remote topology?
- [ ] If rebase/merge paused, did we fully resolve conflicts before running `pull`?
- [ ] Does `main` explicitly track `origin/main`?
- [ ] Is `upstream` remote removed (or intentionally retained) with clear policy?
- [ ] Did we verify end-to-end sync (`pull --rebase origin main` then `push origin main`)?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Independent Development Mode (Origin-only Mainline)`

---

## Branch Strategy Thinking Checklist

When deciding branch strategy for fork + upstream collaboration:
- [ ] Is there a clean upstream mirror branch (`main`) with no product-only commits?
- [ ] Are upstream PR branches created from mirror `main` instead of product branch?
- [ ] Is product development isolated to a dedicated long-lived branch (e.g., `main-custom`)?
- [ ] Is there a periodic sync plan from `main` into product branch?
- [ ] Before force-pushing `origin/main`, did you verify unique commits that may be lost?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Branch Topology for Upstream Collaboration + Custom Product Line`

---

## Monorepo Workspace Dependency Checklist (Build Path)

When fixing build failures in a Bun workspace monorepo (`web`/`hub`/`cli` + shared package):
- [ ] Does every imported workspace package name exactly match the producer package `name` field?
- [ ] Did you run dependency installation at repository root after rename or workspace metadata changes?
- [ ] Is the dependency link visible from the consumer (`web/node_modules/<pkg>`) before diagnosing bundler config?
- [ ] If Vite/Rollup says "failed to resolve import", did you verify package linking first (before alias/external workarounds)?
- [ ] Is there a CI/local prebuild check that validates workspace links for critical shared packages?

Typical failure pattern:
- Import path in app code is correct, but workspace links are stale/missing because install step was skipped after package rename.
- Symptom appears as bundler resolution error, but root cause is dependency graph state.

Recommended fast verification:
1. Check producer package name (e.g. `shared/package.json`).
2. Check consumer dependency declaration (e.g. `web/package.json`).
3. Verify installed link in consumer `node_modules`.
4. Run root install (`bun install`) and rebuild.

---

## Container Service Lifecycle Checklist (Compose ↔ Entrypoint ↔ CLI Process)

When packaging a CLI command as a long-running Docker/Compose service:
- [ ] Is the configured service command designed to remain in the foreground as PID 1?
- [ ] Can the command legitimately exit `0` after setup, handoff, or "already running" detection?
- [ ] If the command manages a background daemon, is the container contract using the daemon process itself rather than the bootstrap command?
- [ ] Does `restart: unless-stopped` interact safely with successful exits, or will it create an infinite restart loop?
- [ ] Is there a compose-level verification that checks both `docker compose ps` state and health status after bootstrap settles?
- [ ] Are logs explicit about whether exit means success, handoff, or failure?

Typical failure pattern:
- A CLI subcommand such as `runner start-sync` performs startup checks, discovers an existing matching runner, prints `Runner already running with matching version`, then exits with code `0`.
- Docker interprets the exit as container completion and restarts it due to restart policy, producing a misleading crash loop even though no exception occurred.

Recommended fast verification:
1. Inspect the command source for `process.exit(0)` branches on success / already-running paths.
2. Run `docker compose up -d` and then check `docker compose ps` after bootstrap delay.
3. Inspect container state for `ExitCode=0` combined with repeated restarts.
4. Only treat the contract as valid when the service remains `Up` and reaches `healthy`.

## Runner Availability Contract Checklist (State File ↔ Process Liveness ↔ Control Port)

When a CLI or background daemon reports availability through persisted state plus runtime probes:
- [ ] Does the availability API distinguish at least `missing`, `stale`, `degraded`, and `running` states instead of returning a bare boolean?
- [ ] If PID liveness and control-port reachability are checked together, are they exposed as separate outcomes rather than collapsed into one false branch?
- [ ] Do caller paths (`start`, `status`, `doctor`, upgrade logic) explicitly decide how to handle `degraded` without treating it as "not running"?
- [ ] Is stale-state cleanup restricted to cases where the owning PID is confirmed dead, rather than any temporary probe failure?
- [ ] Is there an integration test covering "PID alive + control port temporarily unavailable" and asserting state/lock preservation plus correct caller behavior?

Typical failure pattern:
- A helper like `checkIfRunnerRunningAndCleanupStaleState()` returns `false` for both "no runner exists" and "runner process is alive but control endpoint timed out".
- Callers interpret `false` as "there is no runner", causing follow-up actions like restart, stop, doctor output, or version checks to take the wrong branch.

Recommended fast verification:
1. Trace every caller of the availability helper and list what branch they take on each return value.
2. Verify the helper returns a typed status/result object instead of a boolean when more than two runtime states exist.
3. Add an integration test that simulates control-port timeout while PID remains alive.
4. Confirm `start`, `status`, and version-check code paths do not escalate a temporary degraded state into cleanup or restart.

---


When Docker image builds use `bun install --frozen-lockfile` in CI:
- [ ] Does Dockerfile copy **all workspace manifests** used by `bun.lock` before install (root + each workspace `package.json`)?
- [ ] Was `bun.lock` regenerated and committed from repo root after any workspace dependency/script/workspace metadata change?
- [ ] Is local verification done with the same strict mode (`bun install --frozen-lockfile`) before pushing?
- [ ] Does CI pin Bun version consistently with local/dev container to avoid lockfile format drift?
- [ ] Are PR checks configured to fail early when `bun.lock` is dirty (`git diff --exit-code bun.lock` after install)?

Typical failure pattern:
- Docker build reaches `RUN bun install --frozen-lockfile` and fails with `lockfile had changes, but lockfile is frozen`.
- Multi-arch Buildx log may show unrelated platform stage cancellation (`arm64 CANCELED`), while root cause is `amd64` lockfile mutation.

Recommended fast verification:
1. Run `bun install` at repository root.
2. Check whether `bun.lock` changes.
3. If changed, commit `bun.lock` with corresponding manifest changes.
4. Re-run `bun install --frozen-lockfile` locally and in Docker context.

---

## Docker Workflow Scope Checklist (PR 校验 vs 发布)

当 GitHub Actions 同时承担 Docker 校验与镜像发布职责时：
- [ ] PR 触发的 Docker job 是否有明确校验目标（例如仅验证 Dockerfile 可构建）？
- [ ] 如果 PR 不产出用户可见制品，是否避免了发布级成本（QEMU、多架构 Buildx、registry login）？
- [ ] 多架构构建是否只保留在 `main` / tag 发布路径，或已有明确文档说明为什么 PR 必须验证多架构？
- [ ] `packages: write` 是否只授予真正需要推送镜像的 job / 事件？
- [ ] path filter 是否足够精确，避免与 Docker 无关的 PR 触发镜像流程？
- [ ] 评审时是否明确区分了“验证失败”与“流程成本设计错误”？

典型坏味道：
- PR 中 `push=false`，但仍完整执行 QEMU + `linux/amd64,linux/arm64` 构建。
- 表面上没有“发布”，实际上 PR 仍在消耗接近发布级别的 CI 成本。

推荐快速判断：
1. 先看 workflow 的事件边界：`pull_request` 是校验还是发布复用？
2. 再看 Buildx 参数：PR 是否真的需要多架构。
3. 最后看权限与登录：PR 是否不必要地申请 `packages: write` / GHCR 登录。

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Docker Workflow Scope Contract (PR Validation vs Mainline Publish)`

---

## Global Package Manager Context Checklist (Dependency Warning Triage)

When analyzing `pnpm install -g` or other global install warnings:
- [ ] Is the warning from this project's direct dependency graph, or from unrelated global packages already present on the machine?
- [ ] Did you reproduce in a clean environment/profile before changing repository dependencies?
- [ ] Does install succeed and does the shipped CLI binary run (`--help` / basic command)?
- [ ] If warning is external and non-blocking, did you record it as monitored risk instead of forcing repo-level overrides?
- [ ] If warning is from direct dependencies, is there a concrete compatibility plan (upgrade/isolate/pin) with release impact assessed?

Reference executable contract:
- `backend/quality-guidelines.md` -> `Scenario: Global npm Install Peer-Dependency Drift (Published CLI Package)`

---


## Runner Spawn Context Checklist (Launcher ↔ Runtime ↔ Session Metadata)

When a CLI/runner feature spawns real local processes:
- [ ] Did you distinguish runtime execution cwd from the user-requested business working directory?
- [ ] If the runtime needs project-root/module-resolution context, is that fixed structurally instead of inferred from business cwd?
- [ ] If business cwd must survive process spawn, is it passed explicitly (env/config/arg) rather than hidden in runtime launch cwd?
- [ ] Did you verify all entrypoints that read `process.cwd()` or equivalent startup context?
- [ ] Did you check both internal contracts and transport contracts (e.g. internal union type vs HTTP response shape) before rewriting tests?
- [ ] Is there an integration test that proves runner-spawned sessions and terminal-started sessions are both tracked correctly?
- [ ] Did you evaluate host impact separately from state-directory isolation?

Typical failure pattern:
- A spawn helper reuses requested business cwd as runtime cwd.
- Runtime starts from the wrong directory, so aliases/assets fail to resolve.
- Debugging then drifts into test assertions, even though the real bug is a launcher/runtime contract violation.

---
