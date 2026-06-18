# Phase 1 Plan: `/new` UI Preview

## Background and Goals

Current production app is served at `https://tgbackup.030.qzz.io/`. The next phase is a frontend UI refactor focused on reducing visual clutter and making common remote-control tasks faster to understand.

Goals:
- Ship the refactored frontend first at `https://tgbackup.030.qzz.io/new` for user testing.
- Do not change existing `/` behavior during preview.
- Keep all existing API/backend behavior intact unless explicitly replaced later.
- Make simplification reversible: hide, de-emphasize, or move secondary UI before deleting code.

Non-goals for Phase 1:
- No direct production replacement at `/`.
- No backend/API feature removal.
- No automatic promotion from `/new` to `/`.

## Current Frontend Structure Findings

Frontend location:
- Main app: `web/`
- Entry: `web/src/main.tsx`
- Root app shell/auth/SSE/providers: `web/src/App.tsx`
- Router: `web/src/router.tsx`
- Global styles: `web/src/index.css`
- Main UI components: `web/src/components/`
- Session pages: `web/src/routes/sessions/`
- Settings page: `web/src/routes/settings/index.tsx`

Routing:
- TanStack Router route tree in `web/src/router.tsx`.
- Current routes include `/`, `/sessions`, `/sessions/new`, `/sessions/$sessionId`, `/sessions/$sessionId/files`, `/sessions/$sessionId/file`, `/sessions/$sessionId/terminal`, `/browse`, `/settings`.
- `/` redirects to `/sessions`.
- Telegram mode uses memory history in `web/src/main.tsx`; browser mode uses default browser history.
- Current router has no explicit `/new` basepath handling.

Build config:
- Vite config: `web/vite.config.ts`.
- `VITE_BASE_URL` controls Vite `base`, PWA manifest `scope`, and PWA `start_url`; default `/`.
- Web build script: `web/package.json` -> `vite build && cp dist/index.html dist/404.html`.
- Root build script: `bun run build:web`.
- Built files land in `web/dist`.
- PWA service worker: `web/src/sw.ts`; VitePWA injectManifest configured in `web/vite.config.ts`.

Hub/static deploy config:
- Hub serves built web assets in `hub/src/web/server.ts`.
- Non-compiled mode finds `web/dist` and serves `/assets/*`, then static files, then `index.html` fallback for all non-API GET paths.
- Compiled mode embeds `web/dist` via `hub/scripts/generate-embedded-web-assets.ts` and serves embedded assets by exact request path, then falls back to root `index.html`.
- API routes are under `/api/*`; Socket.IO is under `/socket.io/`.
- Current hub server is root-SPA oriented; it does not provide a separate `/new` artifact mount out of the box.

## UI Simplification Principles

Prioritize the 80% path:
- Open session list.
- Identify sessions needing attention.
- Read/send messages.
- Approve/deny permission requests.
- Start a new session.

Simplify by priority:
- Keep state and actions that affect live sessions visible.
- Move secondary controls into menus/drawers.
- Hide noisy diagnostics unless actionable.
- Prefer progressive disclosure over permanent panels.
- Preserve backend-used features and route handlers even when hidden from the default UI.

Concrete candidates to hide/remove/de-emphasize:
- `web/src/components/SessionList.tsx`: de-emphasize machine/project grouping density, copy-path controls, inactive/empty session details, model/flavor labels, todo progress unless incomplete/actionable, and per-group expand noise.
- `web/src/components/SessionHeader.tsx`: keep title/back/primary status; move files, outline, rename/export/archive/delete/reopen into a single overflow or secondary area.
- `web/src/components/AssistantChat/StatusBar.tsx`: keep connection/permission-required state; hide or compress context token counts, cache hit labels, reasoning labels, fast-mode label, and goal label unless warning/actionable.
- `web/src/components/AssistantChat/ComposerButtons.tsx`: keep send, attach if needed, permission/model settings if common; move terminal, schedule send, scratchlist, voice mic controls, switch-to-remote, and abort into clearer contextual affordances.
- `web/src/components/NewSession/`: keep machine, directory, agent, create/cancel; move model, reasoning effort, YOLO, worktree/session type, Cursor/OpenCode advanced pickers behind an "Advanced" section.
- `web/src/routes/settings/index.tsx`: keep settings reachable but avoid prominent navigation unless required.
- `web/src/components/CodexSessionSyncDialog.tsx`, `CursorMigrationBanner.tsx`, voice banners, install/offline/reconnect banners: keep only when actionable; avoid permanent educational text.

Do not delete in Phase 1 unless proved unused:
- API client methods and query/mutation hooks.
- Permission approval UI and tool-result rendering.
- File, terminal, voice, scratchlist, export, migration, Codex import logic.
- Routes needed for deep links, existing users, or backend callbacks.

## `/new` Preview Strategy

Required behavior:
- `https://tgbackup.030.qzz.io/` keeps serving the current UI unchanged.
- `https://tgbackup.030.qzz.io/new` serves the preview UI.
- Preview UI should call the same hub API using `/api/*` and `/socket.io/` on the same origin.
- Preview must not rewrite, redirect, or shadow `/`.

Recommended deployment approach:
- Build a separate preview artifact from the same `web/` app with `VITE_BASE_URL=/new/`.
- Configure router browser history/basepath so browser routes resolve under `/new`:
  - `/new` and `/new/` should land on the preview app and redirect internally to `/new/sessions`.
  - `/new/sessions/...` should match the same logical app routes without requiring root `/sessions`.
- Serve preview static files under `/new/` with SPA fallback to the preview `index.html`.
- Keep `/api/*` and `/socket.io/*` routed to the hub, not the preview static directory.

Reverse-proxy implications:
- If using nginx/Caddy/Cloudflare in front of the existing hub, prefer serving the preview static directory directly at `/new/`.
- Do not proxy `/new/assets/*` to the current hub root unless the hub is updated to serve a second dist directory; current hub only serves root `/assets/*` from `web/dist`.
- Ensure deep links like `/new/sessions/<id>` return the preview `index.html`.
- Ensure cache headers distinguish preview assets from current root assets.

Hub-native alternative:
- Add explicit hub support for a second preview dist directory, e.g. `HAPI_WEB_PREVIEW_DIST_DIR`, mounted at `/new`.
- In non-compiled mode, serve `/new/assets/*`, `/new/*.webmanifest`, `/new/sw.js`, and fallback `/new/*` to preview `index.html`.
- In compiled mode, either skip `/new` support initially or add a separate embedded preview asset manifest. Keep this out of the first deployment unless single-exe preview is required.

PWA/base-path notes:
- `VITE_BASE_URL=/new/` should set asset URLs, manifest `scope`, and `start_url` to `/new/`.
- Validate service worker registration does not control `/`; scope must remain `/new/`.
- Existing root PWA/service worker behavior must remain unchanged.

## Step-by-Step Future Implementation Plan

### Step 1: Add Preview Build/Serve Path

Files:
- `web/vite.config.ts`
- `web/src/router.tsx`
- `web/src/main.tsx`
- `web/package.json`
- Optional hub-native path: `hub/src/web/server.ts`
- Optional deploy docs/config: deployment reverse-proxy config outside repo, if present

Tasks:
- Add a preview build command, e.g. `build:preview`, that sets `VITE_BASE_URL=/new/` and outputs to a separate directory such as `web/dist-new` or a deploy artifact directory.
- Add router basepath handling for browser history when base is `/new/`; keep Telegram memory history behavior unchanged.
- Verify `/new`, `/new/`, `/new/sessions`, and `/new/sessions/<id>` resolve in preview.
- Decide deploy mechanism:
  - Preferred: reverse proxy serves `web/dist-new` at `/new/`.
  - Alternative: hub serves a configured preview dist at `/new/`.

Validation:
- `bun run typecheck:web`
- Build normal app: `bun run build:web`; confirm root output still works.
- Build preview app with `/new/`; confirm generated asset URLs use `/new/`.
- Manual smoke: `/` unchanged, `/new` preview loads, `/api/health` still hub.

Suggested commit:
- `web: add isolated /new preview build path`

### Step 2: Create UI Simplification Flags/Structure

Files:
- `web/src/lib/runtime-config.ts`
- `web/src/App.tsx`
- New small UI config file if useful, e.g. `web/src/lib/ui-mode.ts`

Tasks:
- Add a simple frontend-only UI mode derived from base path or env, e.g. preview mode when `import.meta.env.BASE_URL === '/new/'`.
- Keep default/root mode unchanged.
- Expose a small typed helper such as `isPreviewUiMode()` or `useUiMode()` for components.
- Avoid plumbing large config objects through many components unless needed.

Validation:
- `bun run typecheck:web`
- Existing tests should not require behavior changes in root mode.

Suggested commit:
- `web: gate simplified UI to preview mode`

### Step 3: Simplify Session List

Files:
- `web/src/components/SessionList.tsx`
- Related tests in `web/src/components/SessionList*.test.*`

Tasks:
- In preview mode, reduce each session row to title, attention/status, latest activity, and primary metadata only.
- Hide or de-emphasize path copy buttons, duplicate machine/project metadata, inactive empty stubs, model labels, and non-actionable counts.
- Keep search and new-session entry.
- Keep long-press/context menu actions available.

Validation:
- `bun run test:web -- SessionList`
- `bun run typecheck:web`
- Manual smoke with active session, inactive session, pending permission session, empty state.

Suggested commit:
- `web: simplify preview session list`

### Step 4: Simplify Chat Header and Status

Files:
- `web/src/components/SessionHeader.tsx`
- `web/src/components/AssistantChat/StatusBar.tsx`
- `web/src/components/SessionChat.tsx`

Tasks:
- In preview mode, show only the title, back action, and status that changes user decisions.
- Move file/outline/export/archive/delete/reopen actions behind overflow if not already there.
- Keep permission-required and disconnected states visible.
- Hide context/cache/reasoning/goal labels unless they cross warning thresholds or are needed for current action.

Validation:
- `bun run test:web -- SessionChat`
- `bun run test:web -- StatusBar`
- `bun run typecheck:web`
- Manual smoke for online, offline, thinking, permission-required, reconnecting.

Suggested commit:
- `web: simplify preview chat chrome`

### Step 5: Simplify Composer Controls

Files:
- `web/src/components/AssistantChat/HappyComposer.tsx`
- `web/src/components/AssistantChat/ComposerButtons.tsx`
- Existing composer tests

Tasks:
- In preview mode, keep send and primary input actions clear.
- Move secondary controls such as schedule, scratchlist, terminal, voice, settings, switch remote, and abort into contextual UI or overflow where safe.
- Do not remove handlers; only change default visibility/placement.
- Preserve permission mode/model controls somewhere reachable.

Validation:
- `bun run test:web -- ComposerButtons`
- `bun run test:web -- HappyComposer`
- `bun run typecheck:web`
- Manual smoke send message, attach file, abort active run, switch remote/local, schedule if still exposed.

Suggested commit:
- `web: streamline preview composer controls`

### Step 6: Simplify New Session Flow

Files:
- `web/src/components/NewSession/index.tsx`
- `web/src/components/NewSession/*`
- Existing NewSession tests

Tasks:
- In preview mode, default visible fields to machine, directory, agent, create/cancel.
- Put model, reasoning effort, YOLO, worktree/session type, Cursor variants, and OpenCode model discovery behind Advanced.
- Preserve stored preferences and spawn payload behavior.
- Keep directory existence warnings and runner spawn errors visible.

Validation:
- `bun run test:web -- NewSession`
- `bun run typecheck:web`
- Manual smoke create basic session, create with advanced options, missing directory warning, runner unavailable case.

Suggested commit:
- `web: simplify preview new-session form`

### Step 7: End-to-End Preview Validation

Files:
- Existing Playwright config/tests if adding coverage: `playwright.config.ts`, `e2e/`
- Deployment notes if repo contains them

Tasks:
- Add minimal smoke coverage for preview path if practical:
  - `/new` loads.
  - `/` still loads existing app.
  - `/new` does not redirect to `/`.
  - Preview API calls target `/api/*`.
- Document exact deployment command and reverse-proxy route for `tgbackup.030.qzz.io/new`.

Validation:
- `bun typecheck`
- `bun run test`
- `bun run build:web`
- Preview build command
- Manual browser smoke on deployed URL.

Suggested commit:
- `test: add /new preview smoke coverage`

## PR Acceptance Criteria

- `https://tgbackup.030.qzz.io/` behavior and visual UI remain unchanged.
- `https://tgbackup.030.qzz.io/new` loads the preview UI.
- `/new` supports SPA deep links and refreshes.
- Preview static assets load from `/new/...`, not root `/assets/...`.
- Preview service worker scope is `/new/` and does not control `/`.
- Preview uses the existing hub API and Socket.IO endpoints.
- No backend-used API, route, hook, schema, or RPC behavior is deleted.
- UI simplification is gated to preview mode or otherwise proven not to affect `/`.
- `bun typecheck` passes.
- `bun run test` passes, or failures are documented as unrelated with evidence.
- PR description includes deployment steps and rollback steps for `/new`.

## Risks and Guardrails

Do not break `/`:
- Keep root build, root routes, root service worker, and root static serving unchanged.
- Test `/` after every preview routing/build change.

Do not delete backend-used functionality:
- Prefer hiding/moving UI controls before removing logic.
- Keep API clients, hooks, routes, and permission/tool rendering code unless usage is audited.

Do not auto-promote test UI:
- No redirect from `/` to `/new`.
- No shared deploy artifact that silently replaces root `web/dist`.
- Promotion to `/` must be a separate explicit plan/PR after user testing.

Preview path risk:
- Vite `base=/new/` alone is not enough; router basepath and server/reverse-proxy SPA fallback must also be handled.
- Current hub static serving is root-oriented; serving two UIs from the same hub needs reverse-proxy support or explicit hub changes.

PWA risk:
- Wrong service worker scope can affect root production UI. Validate registration URL and scope in browser devtools before sharing preview broadly.
