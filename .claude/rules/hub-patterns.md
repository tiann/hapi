---
description: Patterns for the hub server package
globs: hub/**
---

# Hub Package Patterns

## Framework: Hono + Socket.IO + Bun SQLite

- HTTP routes use Hono. Register routes via `app.route()`, middleware via `app.use()`.
- WebSocket uses Socket.IO with `@socket.io/bun-engine`. Namespaces: `/cli` (token auth), `/terminal` (JWT auth).
- Database is Bun's native SQLite (`import Database from "bun:sqlite"`). Raw SQL with `.prepare()`, `.all()`, `.get()`, `.exec()`.

## Architecture: Dependency Injection via Factory Functions

Each module exports a factory accepting a deps object:
- `createSocketServer(deps)` → `{ io, engine, rpcRegistry }`
- `createAuthRoutes(jwtSecret, store)` → Hono app
- `registerCliHandlers(socket, deps)` → registers event handlers

## Database Conventions

- Schema versioned via `PRAGMA user_version` with migration functions (`migrateFromV1ToV2()`)
- Foreign keys enabled: `PRAGMA foreign_keys = ON`
- Validate inputs with Zod (`.safeParse()`) before database operations
- Return JSON errors: `c.json({ error: 'message' }, 400)`

## Socket.IO Event Handlers

Register handlers via `socket.on('event-name', handler)` inside `registerCliHandlers(socket, deps)` or similar factory functions. Auth happens in namespace middleware before `on('connection')`.

## Logging

Console with context prefixes: `[Hub]`, `[Web]`, `[Tunnel]`. No centralized logger.
