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

---

## Required Patterns

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

---

## Scenario: Automated Clean PR Delivery Loop (Branch Governor + PR Autopilot)

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
