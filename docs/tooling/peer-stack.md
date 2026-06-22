# HAPI peer stack (isolated hub + web + runner)

Agent-safe isolated stack for feature peers. Does **not** touch production `:3006` or `hapi-active`.

**Where this fits in the overall flow:** [feature-work-lifecycle.md § Three demo topologies](./feature-work-lifecycle.md#three-demo-topologies-operator-picks-at-5) — this file is commands and evidence mechanics only.

## Spike notes (Task 1, 2026-06-20)

### Health

- `GET /health` on the peer hub returns `{ status: 'ok', protocolVersion }` — no auth, no new route needed (`hub/src/web/server.ts`).

### Session seed path (chosen)

1. **Create session:** `POST /cli/sessions` with `Authorization: Bearer $CLI_API_TOKEN` and body `{ tag, metadata: { path, host, flavor } }` — `engine.getOrCreateSession()`; **runner not required** for the row.
2. **Activate session:** connect to Socket.IO namespace `/cli` with `auth: { token, sessionId }`, emit `session-alive` `{ sid, time, thinking: false, mode: 'remote' }` — mirrors `cli/src/api/apiSession.ts`. Required because `POST /api/sessions/:id/messages` uses `requireActive: true`.
3. **Web auth for Playwright:** inject `CLI_API_TOKEN` into `localStorage` key `hapi_access_token::<hubOrigin>` (same as `scripts/dev/session-view-toggles-handoff.mjs`). Web `useAuthSource` accepts access-token auth directly; JWT from `POST /api/auth` is optional.

### Runner default

- **`--no-runner` is not the default.** Most web handoff flows (Send to queue, composer) need an active session; runner is still useful for machine registration even when no live agent is spawned.
- Hub-served web: run hub from `$WORKTREE/hub` after `bun run build:web`; static root resolves to `$WORKTREE/web/dist` via `findWebappDistDir()` (`../web/dist` from hub cwd). No `HAPI_WEB_DIST_DIR` env needed in v1.

## Usage

```bash
# From a feature worktree (canonical layout)
hapi-peer-stack up --name scratchlist-959 \
  --worktree ~/coding/hapi/worktrees/scratchlist-exit-after-send

# Playwright on real session UI
bun run test:e2e:peer e2e/scratchlist-exit-after-queue-peer.spec.ts

hapi-peer-stack status --name scratchlist-959
hapi-peer-stack doctor
hapi-peer-stack down --name scratchlist-959
```

Env file written to `localdocs/peer-stack.env` (gitignored). Registry: `~/.hapi-peer/registry.json`.

See plan: `docs/plans/2026-06-20-hapi-peer-stack-default.md`.

## Evidence modality — agent decides PNG vs MP4

Every feature peer **assesses the task at handoff time** (before peer-stack capture) and records the choice in the handoff message. No separate UXQA spawn — the implementing agent owns the call. Goal: any agent with peer-stack tooling can reliably produce the minimum proof that shows the work.

**Choose PNG when** a still frame is enough:

- Final UI state is the proof (layout, copy, icon, badge, error string, settings value).
- Before/after is at most two frames (e.g. toggle off → on).
- No meaningful motion, timing, or multi-step choreography.
- Change is non-web (CLI, hub API, config) and handoff uses logs or API output instead.

**Choose MP4 when** motion or sequence matters:

- Multi-step flow (open panel → edit → submit → thread updates).
- Animations, transitions, scroll, lazy load, or drag.
- Timing-dependent behavior (debounce, toast, SSE/live update, spinner → done).
- "Exit mode after success" or composer/session chrome behavior.
- Anything where a single screenshot would leave the operator guessing *how* you got there.

**When unsure on web UX:** prefer MP4 (or PNG keyframe **plus** MP4). State the rationale in one line in the handoff.

Capture paths (always under gitignored `localdocs/playwright-runs/`):

- PNG — Playwright screenshot or handoff script `--screenshot`.
- MP4 — Playwright `recordVideo` → `scripts/dev/peer-stack-trim-video.sh`.

Post the chosen artifact(s) **inline in HAPI web** (below) before operator dogfood. After upstream PR opens, attach the **same files to the GitHub PR** (description or comment upload) — **not** `git add`. GitHub hosts the bytes; the repo stays lean.

## Inline evidence (PNG / motion)

**Cursor IDE chat does not render agent `Read()` or markdown images for this operator** — do not use as acceptance path.

### HAPI web session chat (canonical — tiann/hapi#956)

`bun scripts/tooling/hapi-display-image.mjs <session-prefix> <absolute-path> [title]`

Requirements:

1. **`cli` deps installed** — script resolves `@modelcontextprotocol/sdk` from `cli/node_modules`.
2. **Target session must have `metadata.hapiMcpUrl`** — happy MCP (`startHappyServer`) running in that session's CLI. Flavor-agnostic: **#956 is Cursor** with a live bridge; orchestrator session `503d9757` is also Cursor but **lacks** `hapiMcpUrl`. Check per-session GET, do not assume flavor.
3. **Absolute paths only** — MCP runs in the target session CLI cwd; repo-relative paths ENOENT.
4. **List endpoint omits metadata** — script falls back to `GET /api/sessions/:id` for `hapiMcpUrl` (PR #958 pattern).

### MP4 / WebM

- **Disk artifact:** `localdocs/playwright-runs/*.mp4` via `scripts/dev/peer-stack-trim-video.sh`
- **HAPI inline motion:** convert to GIF (`ffmpeg -i clip.mp4 -vf 'fps=8,scale=640:-1' clip.gif`), then `hapi-display-image.mjs` on the GIF
- **HAPI inline MP4/WebM:** `display_video` MCP (same `#956` pipeline as PNG) — `bun scripts/tooling/hapi-display-image.mjs` auto-picks video for mp4/webm
- **HAPI inline motion (legacy):** GIF via `display_image` if CLI lacks `display_video`
- **Cursor IDE:** no inline media — do not promise

Example after peer-stack proof (MCP session — canonical: Cursor `#956`):

```bash
bun scripts/tooling/hapi-display-image.mjs 4971055d \
  "$(pwd)/localdocs/playwright-runs/959-peer-stack.png" \
  "Peer stack #959 - real SessionChat"
```

