# Development Guide

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
