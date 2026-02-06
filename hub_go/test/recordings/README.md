# Live Recording (SSE / Socket.IO)

Requires a running hub and valid CLI token/JWT.

```
HAPI_BASE_URL=http://127.0.0.1:3006 \
HAPI_CLI_TOKEN=<cli-token> \
node hub_go/test/recordings/record-live.ts
```

Optional:
- `HAPI_JWT` to skip /api/auth call.
- `HAPI_SSE_MAX`, `HAPI_SSE_TIMEOUT_MS`.
- `HAPI_SSE_OUT`, `HAPI_SOCKET_OUT` for output paths.

Socket.IO recording uses `socket.io-client`. Install if needed:
```
/data2/hapi/.bun/bin/bun add -d socket.io-client
```
