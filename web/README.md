# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with the shared `CLI_API_TOKEN`.
- The login screen includes a top-right server picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the server via SSE.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.

## Features

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent flavor label (claude/codex/gemini).
- Model mode display.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode toggle (default/acceptEdits/bypassPermissions/plan).
- Model selection (default/sonnet/opus).
- Session abort and mode switch controls.
- Context size display.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### New session (`src/components/NewSession.tsx`)

- Machine selector.
- Directory input with recent paths.
- Agent type selector (claude/codex/gemini).

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses CLI_API_TOKEN from login prompt.
- JWT tokens with auto-refresh.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

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

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi server:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set server CORS to allow the static origin (`WEBAPP_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Server button on the login screen, and enter the hapi server origin.

Clear the server override in the same dialog to return to same-origin behavior.
