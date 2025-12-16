# hapi

Monorepo with three Bun workspace packages:

- `cli/` (`hapi`): CLI (npm package) exposing `hapi` / `hapi-mcp`
- `server/` (`hapi-server`): backend API + Telegram bot server, serves `web/dist/`
- `web/` (`hapi-web`): web frontend (Vite) building to `web/dist/`

## Commands

Run from the repo root:

```bash
bun install
bun run typecheck
bun run build
```
