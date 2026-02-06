# hub_go

Go rewrite scaffold for HAPI Hub. Contracts live under `hub_go/test/contracts` and recordings under `hub_go/test/recordings`.

## Run

```bash
cd /data2/hapi/hub_go

go run ./cmd/hub_go
```

## Config (env)

- `HAPI_HOME` (default: `~/.hapi`)
- `DB_PATH` (default: `{HAPI_HOME}/hapi.db`)
- `HAPI_LISTEN_HOST` (default: `127.0.0.1`)
- `HAPI_LISTEN_PORT` (default: `3006`)
- `HAPI_PUBLIC_URL` (default: `http://localhost:{port}`)
- `CORS_ORIGINS` (default: derived from `HAPI_PUBLIC_URL`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_NOTIFICATION` (default: `true`)
- `CLI_API_TOKEN` (fallback to `settings.json` or auto-generate)

## Notes

- HTTP routes implement in-memory behavior for sessions/machines/messages and simple success stubs for remaining endpoints.
- SSE endpoint keeps the connection alive with comment pings.
- SSE emits `connection-changed`, `session-*`, `message-received`, `machine-updated` on in-memory operations.
- Auth middleware validates JWTs (HS256).
- Telegram bind/auth uses an in-memory store for now (TODO: SQLite parity).
- `/socket.io` endpoints support minimal Engine.IO polling handshake (`open`, `ping/pong`, namespace connect, event ack placeholder).
- `/cli/*` endpoints accept `Authorization: Bearer <CLI_API_TOKEN[:namespace]>`.
