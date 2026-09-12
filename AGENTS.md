# AGENTS.md

Work style: telegraph; noun-phrases ok; drop grammar;

Short guide for AI agents in this repo. Prefer progressive loading: start with the root README, then package READMEs as needed.

## What is HAPI?

Local-first platform for running AI coding agents (Claude Code, Codex, Gemini) with remote control via web/phone. CLI wraps agents and connects to hub; hub serves web app and handles real-time sync.

## Repo layout

```
cli/             - CLI binary, agent wrappers, runner daemon
hub/             - HTTP API + Socket.IO + SSE + Telegram bot
web/             - React PWA for remote control
ios/             - Native SwiftUI app (in development)
android/         - Native Kotlin Compose app (in development)
shared/          - Common types, schemas, utilities
shared/fixtures/ - Golden chat fixtures, generated from web pipeline (never hand-edit)
docs/            - VitePress documentation site
website/         - Marketing site
```

Bun workspaces; `shared` consumed by cli, hub, web. `ios`/`android` outside workspaces (Xcode / Gradle toolchains).

## Architecture overview

```
┌─────────┐  Socket.IO   ┌─────────┐   SSE/REST   ┌─────────┐
│   CLI   │ ──────────── │   Hub   │ ──────────── │   Web   │
│ (agent) │              │ (server)│              │  (PWA)  │
└─────────┘              └─────────┘              └─────────┘
     │                        │                        │
     ├─ Wraps Claude/Codex    ├─ SQLite persistence   ├─ TanStack Query
     ├─ Socket.IO client      ├─ Session cache        ├─ SSE for updates
     └─ RPC handlers          ├─ RPC gateway          └─ assistant-ui
                              └─ Telegram bot
```

**Data flow:**
1. CLI spawns agent (claude/codex/gemini), connects to hub via Socket.IO
2. Agent events → CLI → hub (socket `message` event) → DB + SSE broadcast
3. Web subscribes to SSE `/api/events`, receives live updates
4. User actions → Web → hub REST API → RPC to CLI → agent

## Reference docs

- `README.md` - User overview, quick start
- `cli/README.md` - CLI commands, config, runner
- `hub/README.md` - Hub config, HTTP API, Socket.IO events
- `web/README.md` - Routes, components, hooks
- `docs/guide/` - User guides (installation, how-it-works, FAQ)

## Shared rules

- No backward compatibility: breaking old formats freely
- Prioritize Pragmatism, and Avoid Overengineering.
- Write necessary tests ONLY.
- TypeScript strict; no untyped code
- Bun workspaces; run `bun` commands from repo root
- Path alias `@/*` maps to `./src/*` per package
- Prefer 4-space indentation
- Zod for runtime validation (schemas in `shared/src/schemas.ts`)

## Common commands (repo root)

```bash
bun typecheck           # All packages
bun run test            # cli + hub + web + shared tests
bun run dev             # hub + web concurrently
bun run build:single-exe # All-in-one binary
bun run gen:fixtures    # Regenerate shared/fixtures/ from web pipeline
cd android && ./gradlew :core:protocol:test  # Android protocol conformance
```

iOS tests run in CI (`ios.yml`: macOS `swift test`); no local Xcode/Swift toolchain assumed.

## Key source dirs

### CLI (`cli/src/`)
- `api/` - Hub connection (Socket.IO client, auth)
- `claude/` - Claude Code integration (wrapper, hooks)
- `codex/` - Codex mode integration
- `agent/` - Multi-agent support (Gemini via ACP)
- `runner/` - Background daemon for remote spawn
- `commands/` - CLI subcommands (auth, runner, doctor)
- `modules/` - Tool implementations (ripgrep, difftastic, git)
- `ui/` - Terminal UI (Ink components)

### Hub (`hub/src/`)
- `web/routes/` - REST API endpoints
- `socket/` - Socket.IO setup
- `socket/handlers/cli/` - CLI event handlers (session, terminal, machine, RPC)
- `sync/` - Core logic (sessionCache, messageService, rpcGateway)
- `store/` - SQLite persistence (better-sqlite3)
- `sse/` - Server-Sent Events manager
- `telegram/` - Bot commands, callbacks
- `notifications/` - Push (VAPID) and Telegram notifications
- `config/` - Settings loading, token generation
- `visibility/` - Client visibility tracking

### Web (`web/src/`)
- `routes/` - TanStack Router pages
- `routes/sessions/` - Session views (chat, files, terminal)
- `components/` - Reusable UI (SessionList, SessionChat, NewSession/)
- `hooks/queries/` - TanStack Query hooks
- `hooks/mutations/` - Mutation hooks
- `hooks/useSSE.ts` - SSE subscription
- `api/client.ts` - API client wrapper

### Shared (`shared/src/`)
- `types.ts` - Core types (Session, Message, Machine)
- `schemas.ts` - Zod schemas for validation
- `socket.ts` - Socket.IO event types
- `messages.ts` - Message parsing utilities
- `modes.ts` - Permission/model mode definitions

### iOS (`ios/`)
- `Packages/HapiKit/` - local SPM package: `HapiProtocol` (wire models + chat pipeline, fixtures-verified), `HapiClient` (API/auth/SSE/stores)
- `Hapi/` + `Hapi.xcodeproj` - thin SwiftUI app target

### Android (`android/`)
- `:core:protocol` - pure JVM wire types + chat pipeline (fixtures-verified)
- `:core:data` - transport (OkHttp/SSE), auth, stores
- `:app` - Compose UI, navigation, deep links, FCM

## Protocol conformance (native apps)

- `shared/fixtures/**` machine-generated from the web chat pipeline (source of truth). NEVER hand-edit; edit `web/scripts/fixtures/cases/` + regenerate.
- Changing `web/src/chat/**`, `web/src/lib/message-window-store.ts`, or `web/src/lib/sessionPatch.ts`: run `bun run gen:fixtures`, commit the diff. CI enforces (`.github/workflows/fixtures.yml`); fixture diffs auto-trigger iOS/Android conformance suites (`ios.yml`/`android.yml`).
- Native client contract docs: `docs/api/client-contract/` (auth, rest, sse, pagination, messages, errors).
- Tracks: `ios/` (SwiftUI, iOS 17+) + `android/` (Kotlin Compose, minSdk 26) — independent codebases, share only contract + fixtures. Plan: `~/.claude/plans/web-pwa-abundant-yeti.md`.

## Pre-push self-review (agents)

Before commit/push/PR: use the **`pre-push-review`** skill (`~/.cursor/skills/pre-push-review/`).

1. **Mechanical:** `bun typecheck && bun run test` (matches `.github/workflows/test.yml`)
2. **Logic:** skim `git diff origin/main...HEAD`; apply `.github/prompts/codex-pr-review.md` as a local Major checklist (no Codex required)
3. **Style:** optional

## PR follow-through: review wait + auto-fix loop (agents)

Opening or updating a PR does **not** end the task. Enter a bounded review-wait phase and watch, for the current HEAD: GitHub Checks, PR reviews, plain comments, and inline review comments.

- **One window per HEAD.** Each wait round targets the current HEAD: max 30 minutes, poll every 60s. Prefer a quiet Shell/`gh` polling loop that prints only on state change, new feedback, failure, or timeout — do not re-run full model reasoning every minute, and do not repeat identical output. After an auto-fix is pushed to the same PR branch, restart a fresh wait round from the new HEAD; never cram every round of a task into one 30-minute window.
- **Coverage.** `gh pr checks --watch` covers checks only; it does not replace reviews/comments polling. Also watch new reviews, issue comments, and review comments. Baseline against the current PR, the current HEAD commit, and the feedback already present when the round started, so stale comments are not reprocessed.
- **Auto-fix.** For clear, local feedback that does not change the agreed requirements: verify the point, implement the minimal fix, run scope-matched tests, inspect the diff, commit, and push to the same PR branch, then wait for the next round on the new HEAD. No need to ask the user for each such fix.
- **Loop bound.** At most 100 consecutive auto-fix rounds (one round = one fix-and-push for a tip review point). Stop and report when the cap is hit, when the same blocker survives 100 materially different attempts, or when a wait window ends with no checks/review results — report the current HEAD, feedback handled, items still pending or failing, and the suggested next step. A single-round timeout ends only that wait; never keep editing code with no new feedback just to reach 100 rounds.
- **Stop and ask first.** Do not auto-edit or push when feedback would change product behavior or the original requirements; when several mutually exclusive options would materially change the outcome; when the PR scope must grow; when dependencies, migrations, or architecture changes are involved; when security, credentials, or production are involved; when force-push, history rewrite, or closing/replacing the PR is needed; or when feedback conflicts with user instructions or the PR's stated goal.
- **Bots can be wrong.** Verify against the code, tests, and original requirements before fixing. Do not change code just to silence the bot on a point that does not hold — provide evidence and, when useful, a concise reply.
- **No context burn.** Waiting must not consume context with high-frequency output. Sleep/blocking waits need no model reasoning; hand the model only the minimum necessary information, and only after a state change. If the machine sleeps, the network drops, the GitHub API rate-limits, auth expires, or a tool times out, say so honestly — never claim the wait finished or the checks passed.
- **Contributor-side done.** At minimum: required checks for the current HEAD pass; the latest actionable review feedback is handled or explicitly rejected with reasons; and no verification that should have been re-run after the last fix was skipped. Do not merge into upstream `main` by default (contributors usually lack permission) — report readiness and let the maintainer merge. Merge only when the user explicitly asks and the current account really has write access to the target repo.

## Testing

- Test framework: Vitest (via `bun run test`)
- Test files: `*.test.ts` next to source
- Run: `bun run test` (from root) or `bun run test` (from package)
- Hub tests: `hub/src/**/*.test.ts`
- CLI tests: `cli/src/**/*.test.ts`
- Web tests: `web/src/**/*.test.{ts,tsx}` (fixtures self-check: `web/src/chat/fixtures.test.ts`)

## Common tasks

| Task | Key files |
|------|-----------|
| Add CLI command | `cli/src/commands/`, `cli/src/index.ts` |
| Add API endpoint | `hub/src/web/routes/`, register in `hub/src/web/index.ts` |
| Add Socket.IO event | `hub/src/socket/handlers/cli/`, `shared/src/socket.ts` |
| Add web route | `web/src/routes/`, `web/src/router.tsx` |
| Add web component | `web/src/components/` |
| Modify session logic | `hub/src/sync/sessionCache.ts`, `hub/src/sync/syncEngine.ts` |
| Modify message handling | `hub/src/sync/messageService.ts` |
| Add notification type | `hub/src/notifications/` |
| Add shared type | `shared/src/types.ts`, `shared/src/schemas.ts` |

## Important patterns

- **RPC**: CLI registers handlers (`rpc-register`), hub routes requests via `rpcGateway.ts`
- **Versioned updates**: CLI sends `update-metadata`/`update-state` with version; hub rejects stale
- **Session modes**: `local` (terminal) vs `remote` (web-controlled); switchable mid-session
- **Permission modes**: `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan`
- **Namespaces**: Multi-user isolation via `CLI_API_TOKEN:<namespace>` suffix

## Adding new web features — consider an FUE

When you ship a non-essential feature (the 20% of sessions, not the 80%), consider wrapping its affordance in the generic First-User-Experience primitive so existing users discover it without a giant always-visible UI block.

- **Hook**: `web/src/lib/use-fue.ts` — `useFue(featureId)` returns `{ status, engage, dismiss }`. Storage namespace `hapi.fue.v1.<featureId>` (one localStorage key per feature, isolated from any upstream onboarding flow).
- **Components**: `web/src/components/Fue.tsx` — `<FueDot>` (small pulsing badge for the affordance) and `<FueCallout>` (portal-rendered popover with title/body + "Got it" affirmative-action dismiss).

Pattern (~10 lines around the affordance):

```tsx
const fue = useFue('my-feature')
const buttonRef = useRef<HTMLButtonElement>(null)
return (
    <>
        <button ref={buttonRef} onClick={() => { fue.engage(); doThing() }}>
            <Icon />
            {fue.status !== 'acknowledged' ? <FueDot pulsing={fue.status === 'unseen'} /> : null}
        </button>
        {fue.status === 'engaging' ? (
            <FueCallout
                title={t('myFeature.fueTitle')}
                body={t('myFeature.fueBody')}
                onDismiss={fue.dismiss}
                anchorRef={buttonRef}
            />
        ) : null}
    </>
)
```

Rules:
- Affirmative action only: there is no auto-timeout — user dismisses by clicking "Got it" (reading speed varies).
- The FUE dot and any feature-specific badge (e.g. an entry counter) should be **mutually exclusive**: onboarding signal beats inventory signal until acknowledged.
- Storage is opt-in per-feature; if upstream ships its own onboarding for a feature, just don't wrap that affordance.

Canonical example: scratchlist toggle in `web/src/components/AssistantChat/ComposerButtons.tsx` (`ScratchlistToggleButton`).

## Critical Thinking

1. Fix root cause (not band-aid).
2. Unsure: read more code; if still stuck, ask w/ short options.
3. Conflicts: call out; pick safer path.
4. Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
