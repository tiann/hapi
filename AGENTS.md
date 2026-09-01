# AGENTS.md

Work style: telegraph; noun-phrases ok; drop grammar;

Short guide for AI agents in this repo. Prefer progressive loading: start with the root README, then package READMEs as needed.

## What is HAPI?

Local-first platform for running AI coding agents (Claude Code, Codex, Gemini) with remote control via web/phone. CLI wraps agents and connects to hub; hub serves web app and handles real-time sync.

## Repo layout

HAPI is split by runtime responsibility across Bun workspaces and native projects; see [`docs/guide/development.md#repo-layout`](docs/guide/development.md#repo-layout).

## Architecture overview

CLI, hub, and web communicate through Socket.IO, REST, and SSE; see [`docs/guide/how-it-works.md#developer-architecture-and-data-flow`](docs/guide/how-it-works.md#developer-architecture-and-data-flow).

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

Use the canonical repository commands for checks, development, builds, fixtures, and native conformance; see [`docs/guide/development.md#common-commands-repo-root`](docs/guide/development.md#common-commands-repo-root).

## Key source dirs

Source ownership follows the workspace and native-project boundaries; see [`docs/guide/development.md#key-source-dirs`](docs/guide/development.md#key-source-dirs).

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

## Testing

- Test framework: Vitest (via `bun run test`)
- Test files: `*.test.ts` next to source
- Run: `bun run test` (from root) or `bun run test` (from package)
- Hub tests: `hub/src/**/*.test.ts`
- CLI tests: `cli/src/**/*.test.ts`
- Web tests: `web/src/**/*.test.{ts,tsx}` (fixtures self-check: `web/src/chat/fixtures.test.ts`)

## Common tasks

Changes must be made in each task's owning files; see [`docs/guide/development.md#common-tasks`](docs/guide/development.md#common-tasks).

## Important patterns

- **RPC**: CLI registers handlers (`rpc-register`), hub routes requests via `rpcGateway.ts`
- **Versioned updates**: CLI sends `update-metadata`/`update-state` with version; hub rejects stale
- **Session modes**: `local` (terminal) vs `remote` (web-controlled); switchable mid-session
- **Permission modes**: `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan`
- **Namespaces**: Multi-user isolation via `CLI_API_TOKEN:<namespace>` suffix

## Adding new web features — consider an FUE

Non-essential web features should use the generic FUE primitive when onboarding is warranted; see [`web/README.md#adding-new-web-features--consider-an-fue`](web/README.md#adding-new-web-features--consider-an-fue).

## Critical Thinking

1. Fix root cause (not band-aid).
2. Unsure: read more code; if still stuck, ask w/ short options.
3. Conflicts: call out; pick safer path.
4. Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
