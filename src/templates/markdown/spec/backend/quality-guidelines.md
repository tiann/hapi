# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

HAPI Hub maintains quality through:

- **Strict TypeScript** - No implicit any, strict null checks
- **Bun test** for unit testing (built-in test runner)
- **Zod** for all input validation
- **Graceful error handling** - Don't crash server on bad input
- **Namespace isolation** - Always scope data by namespace

**Build & test commands**:
```bash
bun test           # Run tests
bun run typecheck  # Type check
bun run build      # Build for production
```

---

## Forbidden Patterns

### ❌ Never Use

1. **`any` type**
   ```typescript
   // Bad
   function handle(data: any) { }

   // Good
   function handle(data: unknown) { }
   ```

2. **Zod `.parse()` that throws** - use `.safeParse()` instead
   ```typescript
   // Bad - throws on validation failure
   const data = schema.parse(body)

   // Good - returns result object
   const parsed = schema.safeParse(body)
   if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
   ```

3. **SQL string concatenation** - use prepared statements
   ```typescript
   // Bad - SQL injection risk
   db.query(`SELECT * FROM sessions WHERE id = '${id}'`)

   // Good
   db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
   ```

4. **Direct JSON.parse without error handling**
   ```typescript
   // Bad - throws on invalid JSON
   const data = JSON.parse(row.metadata)

   // Good - use safeJsonParse
   import { safeJsonParse } from './json'
   const data = safeJsonParse(row.metadata)
   ```

5. **Queries without namespace filter** - prevents data leakage
   ```typescript
   // Bad - returns all sessions
   db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)

   // Good - scoped to namespace
   db.prepare('SELECT * FROM sessions WHERE id = ? AND namespace = ?').get(id, namespace)
   ```

6. **Throwing in Socket.IO event handlers**
   ```typescript
   // Bad - crashes socket connection
   socket.on('event', (data) => {
       if (!valid(data)) throw new Error('Invalid data')
   })

   // Good - silently ignore or emit error event
   socket.on('event', (data) => {
       const parsed = schema.safeParse(data)
       if (!parsed.success) return
   })
   ```

7. **Exposing internal error details in API responses**
   ```typescript
   // Bad - leaks implementation details
   return c.json({ error: error.message }, 500)

   // Good - generic message for 500s
   console.error('Operation failed:', error)
   return c.json({ error: 'Internal server error' }, 500)
   ```

8. **Ignoring TypeScript errors**
   ```typescript
   // Bad
   // @ts-ignore
   const value = data.prop

   // Good - fix the type
   const value = typeof data === 'object' && data !== null && 'prop' in data
       ? (data as { prop: unknown }).prop
       : undefined
   ```

9. **Default exports** - use named exports
   ```typescript
   // Bad
   export default function createRoutes() { }

   // Good
   export function createRoutes() { }
   ```

10. **Not checking guard results**
    ```typescript
    // Bad - engine could be a Response
    const engine = requireSyncEngine(c, getSyncEngine)
    engine.getSessions()  // TypeError if engine is Response

    // Good
    const engine = requireSyncEngine(c, getSyncEngine)
    if (engine instanceof Response) return engine
    engine.getSessions()  // Safe
    ```


## Bot Integration Contracts

For GitHub Actions that invoke `openai/codex-action@v1`:

- Treat `responses-api-endpoint` as the final Responses API URL, not as a provider base URL.
- Require custom endpoints to end with `/responses` before the action step runs.
- Reject malformed values such as `https://host/` or `https://host/v1` in workflow preflight checks.
- Prefer explicit runner-local `codex-home` setup to avoid hidden dependence on `~/.codex`.
- When a run still fails with `stream disconnected before response.completed` after URL validation passes, investigate upstream protocol compatibility rather than prompt content first.

---

## Required Patterns

## Container Runtime Contracts

For Docker / runner images that execute Bun-based CLIs:

- Treat production image dependency closure as a runtime contract, not a build optimization detail.
- Do not rely on filtered production installs unless you have verified that all transitive runtime dependencies are materialized in the final image.
- If a runtime path imports packages like `tar`, prefer validating the final image with the actual startup command rather than assuming lockfile completeness is enough.
- For paired env vars such as `ZCF_API_KEY` / `ZCF_API_URL`, validate semantic shape (`key` should not look like URL, `url` should parse as URL) before mutating persisted config.
- If the entrypoint can continue after config warnings, make sure the warning is precise enough to reveal whether the failure is recoverable or whether startup should stop.
- Distinguish **container entrypoint commands** from **daemonized bootstrap commands**. A command that may legitimately exit with code `0` after discovering an existing background process is not a valid Docker PID 1 contract.
- If a CLI subcommand can print messages like `already running` and then `process.exit(0)`, do not wire it directly as a long-running Compose service command.
- For Compose services with `restart: unless-stopped`, verify that the main process is designed to stay in the foreground; otherwise a successful exit will become a restart loop.
- Add an executable validation that checks not only `docker compose up`, but also that the service remains `Up` and reaches `healthy` after initial bootstrap.

---

## Runner Availability Result Contracts

For runtime helpers that combine persisted metadata with live probes:

- Do not compress multi-outcome runtime state into `boolean` when callers must distinguish `missing`, `stale`, `degraded`, and `running`.
- Prefer explicit result objects or discriminated unions for availability helpers used by multiple commands.
- Only delete persisted state/lock metadata when the owning process is confirmed dead; transport or probe failures must not imply stale ownership.
- When a degraded state is possible, document caller behavior explicitly: `start` may accept degraded startup, `doctor` should surface degraded health, and version-check logic should still consider the runner present.
- Any helper signature change at this contract boundary requires auditing all callers in CLI commands, doctor/debug UI, and self-update/restart flows.

---

### ✅ Always Use

1. **Named exports** for all functions, classes, types
2. **Zod schemas** for all external input (HTTP bodies, socket events)
3. **Prepared statements** for all database queries
4. **Namespace filter** in all database queries
5. **Guard pattern** (`T | Response`) for dependency checks in routes
6. **Result types** instead of throwing for multi-outcome operations
7. **`safeJsonParse`** for all JSON column reads
8. **Type annotations** on query results (`as DbSessionRow | undefined`)
9. **`unknown`** type for caught errors (not `any`)
10. **Cleanup** for subscriptions and event listeners

---

## Testing Requirements

### Test Framework

Uses Bun's built-in test runner (`bun test`):

```typescript
import { describe, expect, it } from 'bun:test'

describe('NotificationHub', () => {
    it('sends notification when session becomes ready', async () => {
        // Arrange
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine, [channel])

        // Act
        engine.emit({ type: 'session-ready', session: createSession() })

        // Assert
        expect(channel.readySessions).toHaveLength(1)
    })
})
```

### Testing Patterns

**Fake/Stub over Mock**:

```typescript
// Good - implement the interface
class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            listener(event)
        }
    }
}

// Good - stub that records calls
class StubChannel implements NotificationChannel {
    readonly readySessions: Session[] = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }
}
```

**In-memory database for store tests**:

```typescript
import { Store } from '../store'

function createTestStore(): Store {
    return new Store(':memory:')
}

describe('SessionStore', () => {
    it('creates and retrieves session', () => {
        const store = createTestStore()
        const session = store.sessions.getOrCreateSession('test-tag', {}, null, 'default')
        expect(session.tag).toBe('test-tag')
    })
})
```

**Factory functions for test data**:

```typescript
function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        active: true,
        createdAt: 0,
        updatedAt: 0,
        metadata: null,
        ...overrides
    }
}
```

### What to Test

**Priority 1 - Business logic**:
- Store operations (database CRUD with namespacing, versioning)
- Notification parsing and routing
- Sync engine state transitions
- Socket event handlers with valid/invalid input

**Priority 2 - Utilities**:
- JSON parsing edge cases
- Versioned update conflicts
- Schema migration correctness

**Don't test**:
- Framework boilerplate (Hono route registration)
- Third-party library internals
- Simple getters/setters

### Test File Location

Tests live next to source files:

```
notifications/
├── notificationHub.ts
├── notificationHub.test.ts  ← same directory
└── eventParsing.ts
```


## Scenario: Slash Command Cross-Layer Contract (Project + Nested)

### 1. Scope / Trigger
- Trigger: Changed cross-layer command contract for slash command discovery.
- Why code-spec depth is required:
  - `listSlashCommands` signature changed on CLI side.
  - Response `source` union changed across CLI/Hub/Web.
  - Project-level command scanning behavior changed (recursive).

### 2. Signatures
- CLI command discovery signature:
  - `cli/src/modules/common/slashCommands.ts`
  - `listSlashCommands(agent: string, projectDir?: string): Promise<SlashCommand[]>`
- CLI RPC handler signature:
  - `cli/src/modules/common/handlers/slashCommands.ts`
  - `registerSlashCommandHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void`
- Common handler wiring:
  - `cli/src/modules/common/registerCommonHandlers.ts`
  - must pass `workingDirectory` into `registerSlashCommandHandlers`
- Hub/Sync response contract:
  - `hub/src/sync/rpcGateway.ts`
  - `hub/src/sync/syncEngine.ts`
  - `commands[].source: 'builtin' | 'user' | 'plugin' | 'project'`
- Web type contract:
  - `web/src/types/api.ts`
  - `SlashCommand.source: 'builtin' | 'user' | 'plugin' | 'project'`

### 3. Contracts
- Request contract (session RPC):
  - Method: `listSlashCommands`
  - Params: `{ agent: string }`
  - Note: `projectDir` is not sent over RPC; it is derived from session `workingDirectory` in CLI handler registration.
- Response contract:
  - Shape: `{ success: boolean; commands?: SlashCommand[]; error?: string }`
  - `SlashCommand` fields:
    - `name: string`
    - `description?: string`
    - `source: 'builtin' | 'user' | 'plugin' | 'project'`
    - `content?: string`
    - `pluginName?: string`
- Env/path contract:
  - Global user commands (Claude): `${CLAUDE_CONFIG_DIR ?? ~/.claude}/commands`
  - Project commands (Claude): `<projectDir>/.claude/commands`
  - Global user commands (Codex): `${CODEX_HOME ?? ~/.codex}/prompts`
  - Project commands (Codex): `<projectDir>/.codex/prompts`

### 4. Validation & Error Matrix
- Directory does not exist / no access -> return `[]` for that source (no throw).
- Markdown parse/frontmatter failure -> keep command with fallback description/content behavior.
- Unsupported agent for user/project commands -> return `[]`.
- Duplicate command names across sources -> apply precedence merge (later source overrides earlier).
- RPC failure in Web query -> builtins still available in UI fallback.

### 5. Good/Base/Bad Cases
- Good:
  - Project has `.claude/commands/trellis/start.md`.
  - API returns `trellis:start` with `source: 'project'`.
- Base:
  - No project command directory exists.
  - API returns builtin + available user/plugin commands; no errors.
- Bad:
  - UI/backend `source` unions out of sync (e.g., missing `'project'`).
  - Symptom: type errors or project commands silently filtered out in Web.

### 6. Tests Required (with assertion points)
- CLI unit tests (`cli/src/modules/common/slashCommands.test.ts`):
  - Backward compatibility without `projectDir`.
  - Loads project commands when `projectDir` provided.
  - Same-name conflict resolved to project command.
  - Nested path maps to colon name (`trellis/start.md` -> `trellis:start`).
  - Missing project directory does not throw.
- Type-level checks:
  - `bun run typecheck` must pass for CLI/Hub/Web `source` union consistency.
- Integration verification:
  - Spawn session in project dir and call `GET /api/sessions/:id/slash-commands`.
  - Assert response includes `source: 'project'` commands.

### 7. Wrong vs Correct
#### Wrong
- Non-recursive command scanning (only first-level `.md` files).
- Result: nested commands under `.claude/commands/<group>/` are invisible.

#### Correct
- Recursive scan for `.md` under project command root.
- Convert nested relative path to `:`-separated command name.
- Keep precedence merge:
  - `builtin -> user(global) -> plugin -> project` (project overrides same-name global command).

---

## Scenario: Branch Topology for Upstream Collaboration + Custom Product Line

### 1. Scope / Trigger
- Trigger: Repository workflow requires both upstream-compatible PRs and long-lived custom product commits.
- Why code-spec depth is required:
  - Git branch naming and source base are executable workflow contracts.
  - Wrong base branch directly causes polluted PR diffs and force-push risk.
  - Needs explicit merge/rebase and sync boundaries for `origin` vs `upstream`.

### 2. Signatures
- Long-lived branches:
  - `main` (upstream mirror line)
  - `main-custom` (product line)
- Short-lived branches:
  - `pr/<topic>` (upstream contribution branch, created from `main`)
  - `feature/<topic>` (custom feature branch, created from `main-custom`)
- Remote contracts:
  - `upstream` = canonical repository
  - `origin` = fork repository

### 3. Contracts
- Branch source contract:
  - `pr/*` MUST branch from latest `main` (which mirrors `upstream/main`).
  - `feature/*` MUST branch from latest `main-custom`.
- Sync contract:
  - `main` may be hard-reset to `upstream/main`.
  - `main-custom` must absorb upstream via `merge main` (preferred) or `rebase main`.
- PR contract:
  - Upstream PR head MUST be `origin:pr/*`.
  - `main-custom` commits MUST NOT be sent directly as upstream PR head.

### 4. Validation & Error Matrix
- Create upstream PR from `main-custom` -> error pattern: large unrelated diff; reject and recreate from `main`.
- Commit custom features on `main` -> policy violation; cherry-pick to `main-custom`, then reset `main` to upstream.
- Force-push `origin/main` without confirming impact -> high-risk operation; require explicit confirmation.
- Let `main-custom` drift for too long -> merge conflict spike; schedule periodic upstream sync.

### 5. Good/Base/Bad Cases
- Good:
  - `main == upstream/main`; upstream fix developed in `pr/fix-xxx`; custom roadmap in `main-custom`.
- Base:
  - No custom work yet; `main-custom` currently equals `main`.
- Bad:
  - Single long-lived branch used for both upstream PRs and product work; PRs contain unrelated commits.

### 6. Tests Required (with assertion points)
- Workflow checks (manual, required before opening PR):
  - `git merge-base --is-ancestor upstream/main HEAD` on `pr/*` should pass.
  - `git log --oneline upstream/main..HEAD` on `pr/*` should only show topic commits.
  - `git rev-list --left-right --count upstream/main...main` should be `0\t0` after sync.
- Hygiene checks:
  - Before force-pushing `origin/main`, assert no required unique commits are only on `origin/main`.
  - After syncing `main-custom` from `main`, run project smoke checks relevant to changed areas.

### 7. Wrong vs Correct
#### Wrong
```bash
# create upstream PR branch from custom line
git checkout main-custom
git checkout -b pr/fix-docker
```

#### Correct
```bash
# keep upstream PR branch clean from mirror main
git fetch upstream
git checkout main
git reset --hard upstream/main
git checkout -b pr/fix-docker
```

---

## Scenario: Independent Development Mode (Origin-only Mainline)

### 1. Scope / Trigger
- Trigger: Team decides to stop tracking upstream and move to fully independent development on fork remote only.
- Why code-spec depth is required:
  - Remote topology (`origin`/`upstream`) and branch tracking are executable workflow contracts.
  - Wrong migration sequence can leave rebase/merge half-state and block pull/push.
  - Requires explicit safety and recovery rules for conflict resolution during mainline transition.

### 2. Signatures
- Long-lived branch signature:
  - `main` = independent product mainline (tracks `origin/main` only)
- Optional product branch signature:
  - `product/main` may exist as staging/integration branch, then merged into `main`
- Remote signatures:
  - `origin` = canonical remote after transition
  - `upstream` = removed in independent mode
- Transition command signatures:
  - `git branch -u origin/main main`
  - `git remote remove upstream`

### 3. Contracts
- Canonical remote contract:
  - After transition, release/feature sync operations MUST use `origin/*` only.
- Mainline tracking contract:
  - `main` MUST track `origin/main`; detached or no-upstream state must be fixed before routine pull/push.
- Transition sequencing contract:
  - If `product/main` is source of truth, merge/rebase into `main` first, then update tracking/remotes.
- Conflict recovery contract:
  - If merge/rebase pauses with conflicts, resolve and complete (`rebase --continue` / merge commit) before any `pull`.
- Safety contract:
  - Before topology changes, create `backup/safety-*` anchor for current `main` tip.

### 4. Validation & Error Matrix
- `pull --rebase` while unresolved conflicts exist -> git blocks with unmerged files; resolve then continue/abort rebase.
- `branch --unset-upstream` on branch without upstream -> non-fatal; skip and set desired upstream directly.
- Attempting `remote remove upstream` when already removed -> non-fatal no-op; keep `origin` intact.
- `main` ahead/behind `origin/main` after transition -> run `pull --rebase origin main`, then push.
- Mixed commits (infra + unrelated web) during transition -> split into topic commits before merge to keep history readable.

### 5. Good/Base/Bad Cases
- Good:
  - `main` tracks `origin/main`, no `upstream` remote, transition commit history is conflict-resolved and pushable.
- Base:
  - `upstream` already absent, but `main` upstream tracking still unset; set to `origin/main` and continue.
- Bad:
  - Topology switched mid-rebase without finishing conflict resolution; subsequent pull/push commands fail repeatedly.

### 6. Tests Required (with assertion points)
- Topology assertions:
  - `git remote -v` returns only `origin` in independent mode.
  - `git branch -vv` shows `main` tracking `origin/main`.
- Workflow assertions:
  - `git pull --rebase origin main` succeeds (or reports up to date).
  - `git push origin main` succeeds after transition.
- Conflict-handling assertions:
  - During paused rebase, `git status` must clearly show unmerged paths; after resolution, status must clear conflict markers.

### 7. Wrong vs Correct
#### Wrong
```bash
# pull while rebase conflict is unresolved
git pull --rebase origin main
# remove upstream first without ensuring main tracking/pending conflict state
```

#### Correct
```bash
# 1) resolve paused rebase/merge first
git status
git add <resolved-files>
git rebase --continue

# 2) set independent tracking
git branch -u origin/main main
git remote remove upstream

# 3) sync and publish
git pull --rebase origin main
git push origin main
```

## Scenario: GitHub Actions Codex Home Contract (Bot Workflows)

### 1. Scope / Trigger
- Trigger: GitHub Actions workflows invoke `openai/codex-action@v1` for PR review, mention response, or issue auto-response.
- Why code-spec depth is required:
  - The action writes runner-local server metadata into `codex-home`; if the directory contract is implicit, the workflow can fail before any prompt executes.
  - Failure shows up as action-internal `read-server-info` ENOENT, but the root cause is often missing runner-local state preparation or incompatible endpoint initialization.
  - The contract spans workflow YAML, runner temp filesystem, and external Responses API endpoint configuration.

### 2. Signatures
- Workflow files:
  - `.github/workflows/codex-pr-review.yml`
  - `.github/workflows/codex-mention-response.yml`
  - `.github/workflows/issue-auto-response.yml`
- Action signature:
  - `uses: openai/codex-action@v1`
- Required action inputs/env for stable runner-local state:
  - `codex-home: ${{ runner.temp }}/codex-home`
  - a prior shell step creating that directory
- Endpoint signature:
  - `responses-api-endpoint: ${{ secrets.OPENAI_BASE_URL }}` only when the secret is confirmed to be Responses-API compatible.

### 3. Contracts
- Runner-local state contract:
  - Workflow MUST create the directory used by `codex-home` before invoking `openai/codex-action@v1`.
- Isolation contract:
  - Workflow SHOULD use `${{ runner.temp }}` for `codex-home` instead of relying on default `~/.codex` state.
- Endpoint compatibility contract:
  - `responses-api-endpoint` MUST point to a Responses API compatible base endpoint; if compatibility is unknown, prefer the action default endpoint.
- Failure attribution contract:
  - `Error: Failed to read server info from <codex-home>/<run_id>.json` means the action could not observe the expected server metadata file; treat this as startup/contract failure, not prompt-content failure.

### 4. Validation & Error Matrix
- `ENOENT <codex-home>/<run_id>.json` -> directory missing or action startup failed before writing metadata; verify prepare step and `codex-home` path first.
- `codex-home` omitted -> action falls back to default `~/.codex`; environment-dependent behavior becomes harder to reproduce.
- Custom endpoint configured but not Responses compatible -> startup may fail before metadata file exists; retry with default endpoint or validated compatible base URL.
- Multiple bot workflows share identical assumptions -> fix all Codex workflows, not just the first failing one.

### 5. Good/Base/Bad Cases
- Good:
  - Workflow creates `${{ runner.temp }}/codex-home`, passes `codex-home`, and Codex step starts consistently on fresh runners.
- Base:
  - Workflow uses default endpoint and explicit temp `codex-home`; no custom networking assumptions.
- Bad:
  - Workflow relies on implicit `~/.codex` and treats `read-server-info` ENOENT as flaky model behavior instead of startup contract failure.

### 6. Tests Required (with assertion points)
- Workflow assertions:
  - Each workflow that uses `openai/codex-action@v1` has a preceding `Prepare Codex home` step.
  - Each such action call passes `codex-home: ${{ runner.temp }}/codex-home`.
- Failure triage assertions:
  - If ENOENT reappears, inspect `codex-home` setup and endpoint compatibility before changing prompts.
- Local review assertions:
  - `git diff` shows the directory-prepare step and `codex-home` input added consistently across all Codex workflows.

### 7. Wrong vs Correct
#### Wrong
```yaml
- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    prompt-file: .github/prompts/codex-pr-review.md
```

#### Correct
```yaml
- name: Prepare Codex home
  run: mkdir -p "${{ runner.temp }}/codex-home"

- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    codex-home: ${{ runner.temp }}/codex-home
    prompt-file: .github/prompts/codex-pr-review.md
```

---

### 1. Scope / Trigger
- Trigger: After code implementation, workflow requires automated branch governance, clean PR creation, review-driven iteration, and optional PR replacement.
- Why code-spec depth is required:
  - This flow executes hard-to-reverse git/gh operations (`squash/rebase/close PR/reopen PR`).
  - It spans local git state, fork remote (`origin`), upstream remote (`upstream`), and GitHub PR state.
  - Missing explicit safety contracts can lose commits or create polluted PR history.

### 2. Signatures
- Command signatures:
  - `/trellis:branch-governor`
  - `/trellis:pr-autopilot`
- Recommended runtime args:
  - branch-governor: `mode=audit|fix`, `base=upstream/main`, `protect=product/main,contrib/upstream-main`, `splitPR=true|false`
  - pr-autopilot: `base=upstream/main`, `head=<feature-branch>`, `squash=one|auto|keep`, `watch=on|off`, `maxIterations=<int>`, `allowReopen=true|false`
- Branch role signatures:
  - `product/main`: product-only long-lived line
  - `contrib/upstream-main`: clean upstream contribution baseline
  - `contrib/<topic>`: per-feature PR branch created from `upstream/main`
  - `backup/safety-*`: non-loss safety anchors before history rewrite or PR replacement

### 3. Contracts
- Safety contract:
  - Any operation that may rewrite history or replace PR MUST create `backup/safety-*` first.
- Source contract:
  - Upstream PR head MUST be based on `upstream/main` lineage, not product-only lineage.
- Commit hygiene contract:
  - `contrib/<topic>` SHOULD contain one topic-focused commit when feasible; if not feasible, commit set must still be single-topic.
- Review loop contract:
  - Only blocking review/PIA issues are auto-applied.
  - Non-blocking suggestions are batched into recommendation output, not blindly auto-committed.
- Replacement contract:
  - Close old PR only after new replacement PR exists and is referenced in close comment.

### 4. Validation & Error Matrix
- Missing safety anchor before rebase/squash/close PR -> policy violation; stop and create backup branch first.
- `contrib/*` branch not descendant of `upstream/main` -> high-risk polluted diff; recreate clean branch and cherry-pick topic commits.
- PR contains unrelated commits/files -> split by feature and reopen/replace PR.
- CI green but blocking review exists -> do not mark ready; iterate fix loop.
- Review comments ambiguous/non-reproducible -> output focused clarification plan instead of speculative code edits.
- Attempt to close PR before replacement PR exists -> reject operation.

### 5. Good/Base/Bad Cases
- Good:
  - `branch-governor` audits topology, routes commits by function, then `pr-autopilot` opens a clean Chinese PR and iterates until no blocking signals.
- Base:
  - PR created cleanly; one blocking review comment handled in one additional fix commit.
- Bad:
  - Direct PR from product branch with private config commits, repeated force-push without safety anchor, and speculative fixes to non-blocking comments.

### 6. Tests Required (with assertion points)
- Topology assertions:
  - `git merge-base --is-ancestor upstream/main HEAD` on `contrib/<topic>` must pass.
  - `git log --oneline upstream/main..HEAD` on PR branch contains only topic commits.
- Safety assertions:
  - Before rewrite operations, verify `refs/heads/backup/safety-*` exists.
- PR lifecycle assertions:
  - New PR creation returns valid URL.
  - Replacement flow asserts: new PR exists -> old PR close comment includes replacement reference.
- Review loop assertions:
  - Blocking comments produce concrete fix plan entries.
  - Non-blocking comments are reported but not auto-committed unless explicitly requested.

### 7. Wrong vs Correct
#### Wrong
```bash
# open PR directly from product line with mixed commits
git checkout product/main
gh pr create --base main --head product/main
# then force-push repeatedly without backup
```

#### Correct
```bash
# 1) create safety anchor before rewrite/split
git branch backup/safety-pr-<date> HEAD

# 2) create clean contrib branch from upstream baseline
git fetch upstream
git checkout -b contrib/<topic> upstream/main
git cherry-pick <topic-commits>

# 3) open PR from clean branch
gh pr create --base main --head <fork>:contrib/<topic>

# 4) if replacement needed: open new PR first, then close old PR with replacement link
```

---

## Scenario: Docker Workflow Scope Contract (PR Validation vs Mainline Publish)

### 1. Scope / Trigger
- Trigger: GitHub Actions workflow both validates Docker images on PR and publishes images on `main` / tag pushes.
- Why code-spec depth is required:
  - PR checks and release publishing have different goals, costs, and failure surfaces.
  - If workflow scope is implicit, contributors may unintentionally run expensive multi-arch image builds on every PR even when no publish artifact is needed.
  - The contract spans workflow triggers, Buildx platform matrix, package permissions, and registry push policy.

### 2. Signatures
- Workflow file:
  - `.github/workflows/docker-images.yml`
- Trigger signatures:
  - `pull_request` = validation only
  - `push` to `main` / `tag` = publish path
- Build signatures:
  - PR validation SHOULD prefer the cheapest build that still proves Dockerfile correctness.
  - Publish path MAY use multi-arch build (`linux/amd64,linux/arm64`) and registry push.
- Push signature:
  - `pr-validate`: `push: false`
  - `publish`: `push: true`

### 3. Contracts
- Responsibility contract:
  - PR workflow MUST answer a concrete validation question (for example: “Dockerfile still builds”).
  - If the PR path does not produce a user-visible artifact, it MUST avoid release-grade cost by default.
- Cost boundary contract:
  - Multi-arch Buildx + QEMU SHOULD be reserved for `main` / tag publish path unless PR specifically needs cross-arch verification.
- Publish boundary contract:
  - Registry login and image push MUST NOT happen on `pull_request`.
- Trigger precision contract:
  - Docker workflows SHOULD use path filters or separate jobs so PRs only run image validation when Docker-related inputs changed.
- Escalation contract:
  - If arm64 compatibility is a real product requirement before merge, document that explicitly and keep a dedicated PR verification job instead of piggybacking on publish workflow semantics.

### 4. Validation & Error Matrix
- PR runs Docker workflow, `push=false`, but still performs full multi-arch Buildx/QEMU build -> likely process smell; validation exists, but cost is mis-scoped.
- PR runs single-arch local-equivalent build and catches Dockerfile regression -> expected validation path.
- `main` / tag push skips multi-arch publish -> release contract gap; users may receive stale or missing images.
- PR path logs in to GHCR or requests package write unnecessarily -> permission boundary violation.

### 5. Good/Base/Bad Cases
- Good:
  - PR only verifies required image buildability with the minimum platform scope; `main` / tags perform multi-arch publish.
- Base:
  - PR uses the same Dockerfile but builds `linux/amd64` only with `load: false` / `push: false`; release path adds login and multi-arch push.
- Bad:
  - Every PR pays full QEMU + multi-arch build cost even though the result is never pushed or consumed.

### 6. Tests Required (with assertion points)
- Workflow assertions:
  - `pull_request` path does not push images.
  - PR path does not require `packages: write` unless technically unavoidable.
  - PR validation job uses documented minimal platform scope.
  - `main` / tag path still performs the intended publish flow.
- Review assertions:
  - For any Docker workflow change, reviewers must ask: “Is this job validating, publishing, or both?”
  - If both, reviewers must verify that cost/permission boundaries are explicit in YAML.

### 7. Wrong vs Correct
#### Wrong
```yaml
jobs:
  build:
    steps:
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
```

#### Correct
```yaml
jobs:
  pr-validate:
    if: github.event_name == 'pull_request'
    steps:
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64
          push: false

  publish:
    if: github.event_name != 'pull_request'
    steps:
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
      - uses: docker/build-push-action@v6
        with:
          platforms: linux/amd64,linux/arm64
          push: true
```

---

## Scenario: Post-Merge Conflict Resolution Contract (Workflow Dependencies + Runtime Availability)

### 1. Scope / Trigger
- Trigger: a branch resolves merge conflicts in files that encode executable behavior, especially:
  - `.github/workflows/*.yml`
  - runtime lifecycle helpers such as `cli/src/runner/controlClient.ts`, `cli/src/runner/run.ts`
- Why code-spec depth is required:
  - Conflict resolution often preserves syntax while silently breaking job graphs, step ordering, or caller semantics.
  - The bug may not be local to the conflicted file; it often appears in the next caller that interprets the merged result.

### 2. Signatures
- Workflow dependency signature:
  - `jobs.<job>.needs`
- Workflow release gate signature:
  - validation/smoke steps MUST precede any `push: true` artifact publish
- Runtime availability signature:
  - `getRunnerAvailability(): Promise<{ status: 'missing' | 'stale' | 'degraded' | 'running'; ... }>`
  - `isRunnerRunningCurrentlyInstalledHappyVersion(): Promise<boolean>`
  - `startRunner()` caller branch in `cli/src/runner/run.ts`

### 3. Contracts
- Workflow graph contract:
  - every `needs:` reference MUST resolve to an existing job in the same merged workflow file.
- Publish ordering contract:
  - smoke/validation steps that protect artifact quality MUST run before the irreversible publish step.
- Availability caller contract:
  - if a helper exposes `degraded`, the caller MUST not reinterpret that state as an unconditional restart/replace signal.
- Conflict-resolution contract:
  - after merging, review the helper and every side-effecting caller in the same chain before considering the conflict resolved.

### 4. Validation & Error Matrix
- `needs:` points to removed job -> workflow invalid, guarded job never runs.
- Smoke test exists but runs after `push: true` -> bad artifact can already be published.
- Helper returns `false` for `degraded`, caller maps `false -> stopRunner()` -> temporary control-plane issue becomes forced restart.
- File looks merged cleanly, but caller chain was not replayed -> semantic regression survives review.

### 5. Good/Base/Bad Cases
- Good:
  - merged workflow keeps valid `needs`, validation runs before publish, and degraded runtime does not trigger stop/restart.
- Base:
  - workflow passes syntax but still requires explicit `gh`/review inspection of job graph and order.
- Bad:
  - merge only removes conflict markers; no one checks dependency edges, publish ordering, or downstream caller behavior.

### 6. Tests Required (with assertion points)
- Workflow assertions:
  - no `needs:` entry references a missing job.
  - smoke/validation runs before artifact push.
- Runtime assertions:
  - `degraded` availability does not trigger `stopRunner()` or forced restart path.
  - same-PID stale state remains distinguishable from degraded live state.
- Review assertions:
  - when conflict resolution touches helper return semantics, reviewers must inspect all callers with side effects.

### 7. Wrong vs Correct
#### Wrong
```yaml
compose-smoke:
  needs: build
```

```ts
if (availability.status !== 'running') {
  return false; // caller will stop current runner
}
```

#### Correct
```yaml
compose-smoke:
  if: github.event_name != 'pull_request'
  needs: publish
```

```ts
if (availability.status === 'degraded') {
  return true; // preserve current runner, avoid forced restart
}
```

---

## Scenario: Docker Build Lockfile Freeze Contract (Bun Workspace CI)

### 1. Scope / Trigger
- Trigger: GitHub Actions Docker multi-arch build fails at `bun install --frozen-lockfile`.
- Why code-spec depth is required:
  - Lockfile immutability is an executable CI contract, not a soft convention.
  - Failure appears inside Docker Buildx pipeline, but root cause often originates from repository dependency graph drift.
  - Requires synchronized handling across `package.json` manifests, `bun.lock`, Dockerfile copy order, and CI validation commands.

### 2. Signatures
- Docker install step signature:
  - `Dockerfile.hub`, `Dockerfile.runner`
  - `RUN bun install --frozen-lockfile`
- Workspace manifest copy signature:
  - root `package.json`, root `bun.lock`, and all workspace `*/package.json` included in lock resolution.
- CI workflow signature:
  - `.github/workflows/docker-images.yml`
  - `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`

### 3. Contracts
- Lockfile immutability contract:
  - If any workspace dependency graph changed, `bun.lock` MUST be regenerated and committed before CI Docker build.
- Docker context contract:
  - Dockerfile MUST copy all manifests participating in lock resolution before `bun install --frozen-lockfile`.
- Version consistency contract:
  - Bun version in local/dev/CI SHOULD be pinned consistently to avoid lockfile format and resolver drift.
- Failure attribution contract:
  - In multi-arch logs, canceled secondary platform stages MUST NOT be treated as root cause when primary stage reports lockfile mutation.

### 4. Validation & Error Matrix
- `lockfile had changes, but lockfile is frozen` in Docker step -> missing/stale committed `bun.lock`; regenerate at repo root and commit.
- Added/changed workspace `package.json` not copied before install -> Docker resolver differs from repo state; update Dockerfile copy list.
- Local `bun install` passes but frozen fails in CI -> Bun version mismatch; align Bun versions and rerun frozen install locally.
- Buildx shows `linux/arm64 CANCELED` -> secondary cancellation due to another platform failure; inspect first failing platform logs (often amd64).

### 5. Good/Base/Bad Cases
- Good:
  - Developer updates workspace manifest, runs root `bun install`, commits `bun.lock`, local frozen install passes, CI Docker build passes.
- Base:
  - No dependency graph changes; frozen install remains deterministic across local and CI.
- Bad:
  - Manifest changed without lockfile commit; CI fails at frozen install and noise from other platform cancellation obscures diagnosis.

### 6. Tests Required (with assertion points)
- Local pre-push assertions:
  - `bun install --frozen-lockfile` succeeds at repo root.
  - `git diff --exit-code bun.lock` returns clean after install.
- Docker assertions:
  - `docker build -f Dockerfile.hub .` reaches install step without lockfile mutation.
  - `docker build -f Dockerfile.runner .` reaches install step without lockfile mutation.
- CI assertions:
  - `.github/workflows/docker-images.yml` path filter includes lock/manifests and Dockerfiles.
  - Build matrix fail log triage identifies first failing platform and command.

### 7. Wrong vs Correct
#### Wrong
```bash
# update workspace package.json only
# push directly and rely on CI to resolve lock drift
```

#### Correct
```bash
# after any dependency graph change
bun install
git add bun.lock
# optional strict check
bun install --frozen-lockfile
# then push / open PR
```

---

## Scenario: Voice Assistant Decommission Contract (Web + Hub + Shared + Docs)

### 1. Scope / Trigger
- Trigger: Remove an existing cross-layer capability (`Voice Assistant` / ElevenLabs) in a single phase.
- Why code-spec depth is required:
  - API contract removal (`POST /api/voice/token`) spans frontend call sites and backend route registration.
  - Shared protocol export removal (`@hapi/protocol/voice`) affects compile-time imports across multiple packages.
  - User-facing contract changes require synchronized docs, settings UI, and i18n cleanup.

### 2. Signatures
- Backend route signature to remove:
  - `hub/src/web/routes/voice.ts`
  - `createVoiceRoutes(): Hono<WebAppEnv>`
  - `POST /voice/token`
- Backend route registration signature to remove:
  - `hub/src/web/server.ts`
  - `app.route('/api', createVoiceRoutes())`
- Frontend API signature to remove:
  - `web/src/api/client.ts`
  - `fetchVoiceToken(credentials?: VoiceCredentials): Promise<VoiceTokenResponse>`
- Shared package export signature to remove:
  - `shared/package.json`
  - `"./voice": "./src/voice.ts"`

### 3. Contracts
- Request contract (removed):
  - Endpoint: `POST /api/voice/token`
  - Request body: `{ customAgentId?: string; customApiKey?: string }`
  - Response body: `{ allowed: boolean; token?: string; agentId?: string; error?: string }`
- Env contract (removed):
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_AGENT_ID`
- Frontend behavior contract (after removal):
  - UI MUST NOT render voice entry points in composer/settings.
  - Runtime MUST NOT initiate `/api/voice/token` requests.
- Build contract (after removal):
  - No remaining import of `@hapi/protocol/voice`.
  - No remaining dependency on `@elevenlabs/react` in `web/package.json`.

### 4. Validation & Error Matrix
- Residual frontend API call to `/api/voice/token` -> 404/runtime noise; fix by removing call sites and state branches.
- Residual backend `createVoiceRoutes` import/registration -> TypeScript compile failure; remove import + route mount together.
- Residual `@hapi/protocol/voice` import after export removal -> unresolved module error; remove import chain before/with export deletion.
- Docs still mention ElevenLabs env keys after code removal -> operational confusion; remove docs links and setup sections.
- i18n/settings keys removed incompletely -> dead UI labels or lint noise; remove keys and corresponding settings blocks together.

### 5. Good/Base/Bad Cases
- Good:
  - Web/Hub typecheck/test/build pass.
  - No `/api/voice/token` route or client call remains.
  - No `@hapi/protocol/voice` imports and no `@elevenlabs/react` dependency.
  - Docs no longer reference Voice Assistant/ElevenLabs setup.
- Base:
  - Voice feature files removed; text chat, permission handling, session switching still function.
- Bad:
  - Only UI is hidden but backend/shared contracts remain.
  - Or backend is deleted while frontend still calls removed endpoint.

### 6. Tests Required (with assertion points)
- Type-level assertions:
  - `bun run --cwd web typecheck` passes (assert: no missing voice symbols/types/imports).
  - `bun run --cwd hub typecheck` passes (assert: no `createVoiceRoutes` / route import residue).
- Runtime/test assertions:
  - `bun run --cwd web test` passes (assert: settings/chat tests no longer depend on voice state).
  - `bun run --cwd hub test` passes.
- Build assertions:
  - `bun run --cwd web build` passes (assert: no voice vendor chunk rule/dependency required).
- Optional grep assertions (recommended):
  - No source/docs matches for `@hapi/protocol/voice`, `/api/voice/token`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`.

### 7. Wrong vs Correct
#### Wrong
```ts
// Only remove UI toggle, keep API + shared contract alive
// - Composer voice button hidden
// - fetchVoiceToken still exists and can be called
// - backend /api/voice/token route still mounted
```

#### Correct
```ts
// Remove capability end-to-end in one contract change:
// 1) Remove web entry/state/hooks/api call paths
// 2) Remove hub route file + server registration
// 3) Remove shared voice export/module
// 4) Remove dependency/docs/env references
```

---

## Scenario: Chinese-Primary Documentation Terminology Contract

### 1. Scope / Trigger
- Trigger: Documentation localization and terminology normalization across `README.md` and `docs/guide/*.md`.
- Why this matters:
  - Mixed naming (`hub`/`Hub`, `session`/`会话`) creates cognitive overhead and inconsistent UX copy.
  - Drift between docs makes search, onboarding, and maintenance harder.

### 2. Signatures
- Documentation scope (current project convention):
  - `README.md`
  - `cli/README.md`
  - `hub/README.md`
  - `web/README.md`
  - `docs/guide/*.md`
- Excluded scope for localization in this task line:
  - `.claude/**`
  - `.github/**`
  - `.trellis/**`

### 3. Contracts
- Language contract:
  - User-facing product docs are Chinese-primary.
  - Technical tokens/commands/paths remain literal (e.g., `hapi hub`, `/api/events`, `runner.state.json`).
- Terminology contract:
  - Product component names use consistent title form in prose: `Hub`, `Runner`, `Session`.
  - Generic concept text prefers Chinese term `会话`; keep English token only when needed for protocol/UI labels.
- Style contract:
  - Do not alter executable snippets when only normalizing prose terminology.

### 4. Validation & Error Matrix
- Prose contains lowercase `hub` for product component mention -> normalize to `Hub`.
- Mixed `session` and `会话` in adjacent prose without protocol reason -> normalize to `会话` (or explicit mixed form once, then consistent).
- Terminology edits inside command/code blocks -> reject change and keep literal tokens.
- Localization accidentally touches excluded directories -> revert those edits.

### 5. Good/Base/Bad Cases
- Good:
  - `web/README.md` uses `Hub` consistently in prose, while preserving `hapi hub` in commands.
- Base:
  - Existing docs already Chinese-primary; only minor terminology cleanup needed.
- Bad:
  - Blind global replace modifies command literals or API paths.

### 6. Tests Required (with assertion points)
- Grep assertions (docs-only):
  - Search for inconsistent prose tokens in target docs and review hits manually.
  - Assert no unintended edits under `.claude/.github/.trellis`.
- Review assertions:
  - Commands/paths/API literals remain unchanged.
  - Terminology consistency preserved in modified files.

### 7. Wrong vs Correct
#### Wrong
```md
登录页右上角有 hub 选择器；输入 hapi hub 的 origin。
```

#### Correct
```md
登录页右上角有 Hub 选择器；输入 hapi Hub 的 origin。
# command literal stays unchanged in code block: `hapi hub`
```

---

## Scenario: Global npm Install Peer-Dependency Drift (Published CLI Package)

### 1. Scope / Trigger
- Trigger: Running `pnpm install -g @jlovec/zhushen` prints peer dependency warning from transitive global package graph.
- Why code-spec depth is required:
  - This is a cross-boundary contract between published package metadata, npm/pnpm global store behavior, and end-user install UX.
  - Warning-only failures are easy to ignore, but repeated warnings hide real incompatibilities later.
  - Needs explicit triage contract to distinguish benign warning vs actionable incompatibility.

### 2. Signatures
- Published package signature:
  - `cli/package.json`
  - `name: "@jlovec/zhushen"`
  - `optionalDependencies: @jlovec/zhushen-<platform>`
- Packaging generation signature:
  - `cli/scripts/prepare-npm-packages.ts`
  - `buildOptionalDependencies(version: string): Record<string, string>`
- Install command signature:
  - `pnpm install -g @jlovec/zhushen`

### 3. Contracts
- Runtime contract:
  - CLI runtime MUST NOT depend on unrelated global packages being peer-clean.
  - Global peer warnings from third-party trees (`@qingchencloud/openclaw-zh -> ... -> zod-to-json-schema@3.24.6`) are non-blocking unless CLI behavior fails.
- Dependency contract:
  - Workspace packages use Zod v4 (`^4.x`) as canonical baseline.
  - Any direct dependency newly introducing `zod@^3`-only peer range is disallowed without compatibility review.
- Release contract:
  - Pre-release validation MUST include a clean-environment global install smoke test and warning classification.

### 4. Validation & Error Matrix
- `pnpm install -g` prints peer warning, CLI launch works -> classify as `Warning/External`, record and monitor.
- `pnpm install -g` fails with dependency resolution error -> classify as `Blocking`, stop release.
- Global warning references package not in repository dependency graph -> do not patch project lockfile blindly; verify install context first.
- New repo dependency introduces incompatible peer range (`zod@^3` only) -> block merge until upgraded or isolated.

### 5. Good/Base/Bad Cases
- Good:
  - Install succeeds, warning来源于外部全局包，`zs` command works normally.
- Base:
  - Install has no peer warnings; binary package resolves correctly for current platform.
- Bad:
  - Treat every global warning as project defect and force-add overrides in project, causing unnecessary dependency complexity.

### 6. Tests Required (with assertion points)
- Release smoke checks:
  - `pnpm install -g @jlovec/zhushen` in clean container/user profile.
  - Assert install exits `0` and `zs --help` exits `0`.
- Dependency graph checks:
  - Search direct manifests for risky peers before release (`zod@^3`-only ranges in direct deps).
  - Assert `cli/package.json` optional platform deps match current version.
- Regression checks:
  - Run workspace `bun run typecheck` + CLI tests to ensure no runtime/type coupling to warned package tree.

### 7. Wrong vs Correct
#### Wrong
```bash
# See global peer warning and immediately patch project dependencies/lockfile
# without proving warning comes from this package graph.
```

#### Correct
```bash
# 1) Reproduce in clean environment
pnpm install -g @jlovec/zhushen

# 2) Validate runtime
zs --help

# 3) If warning is external/non-blocking, record as monitored risk;
#    only change repo deps when direct graph proves incompatibility.
```

### Before Submitting

- [ ] `bun run typecheck` passes (no TypeScript errors)
- [ ] `bun test` passes
- [ ] No `any` types
- [ ] No SQL string concatenation
- [ ] All inputs validated with Zod `.safeParse()`
- [ ] All queries filter by namespace
- [ ] Guard results checked (`instanceof Response`)
- [ ] Errors handled gracefully (no unhandled rejections)
- [ ] No internal error details exposed in HTTP responses

### Reviewer Checklist

**Security**:
- [ ] Prepared statements (no SQL injection)
- [ ] Namespace isolation in all queries
- [ ] No internal error details in responses
- [ ] Input validated before processing

**Error Handling**:
- [ ] Guard results checked
- [ ] Zod `.safeParse()` used (not `.parse()`)
- [ ] Background errors logged but don't crash service
- [ ] Appropriate HTTP status codes

**TypeScript**:
- [ ] No `any` types
- [ ] Query results typed (`as DbRowType | undefined`)
- [ ] Named exports only

**Database**:
- [ ] Prepared statements used
- [ ] Namespace filter on all queries
- [ ] Versioned updates for concurrent modifications
- [ ] Foreign keys respected

**Testing**:
- [ ] New business logic has tests
- [ ] Tests use factory functions, not raw objects
- [ ] Tests use `:memory:` database when needed

---

## TypeScript Configuration

### Hub (`hub/tsconfig.json`)

```json
{
    "extends": "../tsconfig.base.json",
    "compilerOptions": {
        "target": "ESNext",
        "module": "ESNext",
        "types": ["bun-types"],
        "baseUrl": "."
    },
    "include": ["src"]
}
```

**Inherits from `tsconfig.base.json`**:
- `strict: true` - All strict checks
- `noImplicitAny: true` - No implicit any
- `strictNullChecks: true` - Explicit null handling
- `noImplicitReturns: true` - All paths must return

---

## Summary

**Core principles**:
1. **Security first** - No SQL injection, no data leakage across namespaces
2. **Fail gracefully** - Validate all input, don't crash on bad data
3. **Type safety** - Strict TypeScript, no `any`, typed query results
4. **Test business logic** - Store operations, event handling, state transitions
5. **Consistent patterns** - Guard pattern, result types, named exports
