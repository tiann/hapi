# HAPI Project Instructions

## Dev Build & Hub Management

Use `bun run rebuild` to build from source and restart the local hub. This compiles the CLI binary, replaces the globally-installed `hapi`, and restarts the hub process with a health check.

```
bun run rebuild            # full: stop → build → install binary → start
bun run rebuild restart    # restart hub without rebuilding
bun run rebuild stop       # stop the hub
bun run rebuild status     # check if hub is running
bun run rebuild logs       # tail hub.log
```

After editing hub or shared code, run `bun run rebuild` to pick up changes. After editing only web code, use `bun run dev:web` for faster iteration with HMR.

## Project Structure

- `shared/` — `@hapi/protocol`: Zod schemas, types, and utilities shared across packages
- `hub/` — local hub server (Hono + Socket.IO + Bun SQLite)
- `cli/` — CLI client that connects to the hub
- `web/` — React 19 SPA (TanStack Router + Query, Tailwind CSS)

## Testing

```
bun run test               # all packages
bun run test:hub           # hub only
bun run test:web           # web only
bun run test:cli           # cli only
bun run typecheck          # tsc --noEmit across all packages
```

## Agent Context

- `.claude/rules/` — path-scoped rules auto-loaded when working in hub/, web/, shared/, or test files
- `.claude/agents/` — specialized agents (bug-detective, test-runner, git-ops, code-reviewer)
- `.claude/shared/` — shared workflows referenced by agents (TDD, core rules)
