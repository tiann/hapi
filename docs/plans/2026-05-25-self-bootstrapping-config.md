# Self-Bootstrapping Configuration

**Status:** Planning  
**Author:** HeavyGee  
**Date:** 2026-05-25

## Vision

Hapi should be self-configuring after a minimal bootstrap. API keys, voice backend selection, Telegram token, CORS origins — all entered through the web UI and stored in the hub's SQLite DB. The config file drops to the absolute minimum needed to start the process.

---

## Minimal bootstrap (target)

```bash
# All that should ever need to go in a file
HAPI_LISTEN_PORT=3006
HAPI_PUBLIC_URL=https://your-domain
# JWT secret and CLI token auto-generated on first run (already works)
```

Everything else is configured through a first-run wizard or the settings page.

---

## Phases

### Phase 1 — Backend picker (follow-on to PR #692)

Small, self-contained, concrete value now.

- `GET /api/voice/backends` returns only the backends with keys configured on the hub
- Settings page adds a **Voice backend** dropdown — hidden if only one backend available
- Frontend passes selection to `VoiceBackendSession`
- ElevenLabs → voice picker still shown; Gemini/Qwen → voice picker hidden
- Selection stored in localStorage

Files touched: `hub/src/web/routes/voice.ts`, `web/src/routes/settings/index.tsx`, `web/src/realtime/VoiceBackendSession.tsx`

### Phase 2 — Config table in SQLite

Introduces the persistence layer for runtime config.

- New `settings` table: `key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER`
- `getConfiguration()` checks DB first, falls back to env var, falls back to default
- Values written to DB survive restarts without touching the env file
- Keys that genuinely require restart (port, listen host, JWT secret) flagged as `restart_required` and handled separately
- No encryption initially — self-hosted assumption, SQLite file is already on a trusted host

Hub files: `hub/src/store/`, `hub/src/configuration.ts`

### Phase 3 — API key management UI

Settings page sections for each integration, behind the existing auth wall.

**Voice section:**
- ElevenLabs API key — masked input, **Test connection** button (calls `GET /voice/voices`, shows count)
- Gemini API key — masked input, **Test connection** button (hits Gemini models endpoint)
- DashScope API key — masked input, **Test connection** button
- Active backend dropdown (Phase 1, now reads from DB not env)

**Notifications section:**
- Telegram bot token — masked input, **Test** button
- VAPID keys — auto-generated button

**Hub section:**
- Public URL
- CORS origins
- (Port/host remain file-only — restart required, flag clearly)

Each key: save → hub writes to DB → config layer picks up immediately, no restart.

Web files: `web/src/routes/settings/index.tsx` (already the right place)  
Hub files: new `hub/src/web/routes/config.ts`

### Phase 4 — First-run wizard

For new installs with no config at all.

- Hub detects first run (no owner, no CLI token set)
- Serves a `/setup` route (pre-auth, but rate-limited / IP-gated)
- Step 1: Set admin password / generate CLI token — shown once, copy to CLI config
- Step 2: Public URL + optional CORS origins
- Step 3: Add at least one voice backend key (skippable)
- Step 4: Optional Telegram
- Done → redirect to normal app

This is the "zero SSH" experience. Someone could install the binary, point a domain at it, open the URL, and be fully configured without ever touching a file.

---

## Design decisions

### Secrets in DB vs env

Env vars are the conventional pattern for secrets, but they require file access and restart. For a self-hosted single-user tool, storing keys in SQLite is pragmatically fine. The SQLite file is already on the trusted host behind auth.

Future option: encrypt DB values at rest using the JWT secret as the key. Creates a clean bootstrap — you need the JWT secret (in the file) to decrypt the DB (which has everything else). One secret to rule them all.

### Hot reload

API keys read from DB on each request — no caching at the module level for those values. Port, listen host, JWT secret remain file-only because they're needed before the DB is open. Everything else: change in UI → takes effect on next request, no restart.

### Config layer changes

`getConfiguration()` currently reads env at call time (already refactored from the static import). Extend to:

```typescript
async function getConfigValue(key: string, envVar: string, defaultValue?: string): Promise<string | undefined> {
    const dbValue = await store.getSetting(key)
    if (dbValue) return dbValue
    return process.env[envVar] ?? defaultValue
}
```

The async change ripples through callers, but most are already in async contexts.

---

## What this is NOT

- Not a multi-user permission system — Hapi is single-owner, the auth wall is the boundary
- Not a hosted/SaaS config store — all local, all in the SQLite file alongside the rest of the data
- Not trying to replace docker-compose or secrets managers for power users — env vars still work as overrides

---

## Filing order

1. PR: backend picker (small, ships with voice work) — **ready to start**
2. Issue: config table + settings API — file upstream to gauge interest before investing
3. PR: API key management UI — depends on 2
4. PR: first-run wizard — depends on 3, biggest lift, most user-facing value

---

## Related

- PR #690 — voice picker (ElevenLabs voices in settings)
- PR #692 — pluggable voice backend (Gemini Live + Qwen)
- `docs/plans/2026-05-25-voice-picker-handoff.md` — voice work context
