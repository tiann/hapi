# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does
- Session list with status, pending approvals, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.

## Runtime behavior
- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with the shared `CLI_API_TOKEN`.
- Live updates come from the server via SSE.

## Development
From the repo root:
```bash
bun install
bun run dev:web
```

If testing in Telegram, set:
- `WEBAPP_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Build
```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-server. The single executable can embed these assets.

## Stack
React 19 + Vite + TanStack Router/Query + Tailwind.
