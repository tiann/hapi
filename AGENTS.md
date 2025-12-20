# AGENTS.md

Guidelines for AI agents working in this workspace.

## Monorepo Structure

Bun workspaces monorepo with three packages:

| Package | Path | Purpose |
|---------|------|---------|
| `hapi` | `cli/` | CLI tool (single executable) - `hapi` / `hapi mcp` |
| `hapi-server` | `server/` | API server + Telegram bot (serves `web/dist/`) |
| `hapi-web` | `web/` | Web frontend / Mini App / PWA (Vite → `dist/`) |

```
hapi/
├── package.json              # Workspace root
├── tsconfig.base.json        # Shared TS config
├── cli/
│   ├── package.json          # npm: hapi
│   ├── src/                  # CLI source
│   └── bin/                  # Executables
├── server/
│   ├── package.json          # private
│   └── src/                  # Hono + Socket.IO + Grammy
└── web/
    ├── package.json          # private
    ├── vite.config.ts
    └── src/                  # React + Tailwind
```

## Shared Rules

- **TypeScript strict** - No untyped code
- **Bun workspaces** - Run `bun install` / `bun run ...` from repo root
- **Path aliases** - `@/*` → `./src/*` (per-package tsconfig)
- **No backward compatibility** - Break old formats freely
- **4-space indent** - Prefer 4 spaces

## Commands

Run from repo root:

```bash
# Build
bun run build            # Build all packages
bun run build:cli        # CLI only (pkgroll → CJS + ESM)
bun run build:server     # Server only (bun build)
bun run build:web        # Web only (Vite)

# Type check
bun run typecheck        # All packages

# Development
bun run dev:server       # Server with --watch
bun run dev:web          # Vite dev server

# Test
bun run test             # CLI tests (Vitest)
```

## Package Details

### cli/ (hapi)
- **Entry**: `src/index.ts` → `bin/happy.mjs`
- **Build**: `pkgroll` generates CJS + ESM bundles
- **Test**: `vitest` with `.env.integration-test`
- **Publish**: `npm publish` (see `cli/package.json`)

### server/ (hapi-server)
- **Entry**: `src/index.ts`
- **Runtime**: Bun
- **Stack**: Hono (HTTP) + Socket.IO + Grammy (Telegram)
- **Static**: Serves `../web/dist/` via `src/web/server.ts`

### web/ (hapi-web)
- **Entry**: `src/main.tsx`
- **Stack**: React 19 + Tailwind + Vite
- **Output**: `dist/` (served by server)

## Key Source Directories

| Package | Key Paths |
|---------|-----------|
| cli | `src/api/`, `src/claude/`, `src/commands/`, `src/codex/` |
| server | `src/web/`, `src/socket/`, `src/telegram/`, `src/sync/` |
| web | `src/components/`, `src/api/`, `src/hooks/` |
