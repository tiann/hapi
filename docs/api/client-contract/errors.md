# Errors

Error semantics for all `/api/*` endpoints. Grounded in `hub/src/web/routes/guards.ts` and the individual route files under `hub/src/web/routes/`; reference consumer `web/src/api/client.ts` (`ApiError`, `parseErrorCode`).

## Body shape

Error responses are JSON:

```json
{ "error": "Session is inactive", "code": "session_inactive" }
```

- `error` — human-readable message. **Never match on it**: consumers i18n it and the hub may reword it (this rule is stated in `guards.ts` itself).
- `code` — optional stable machine-readable discriminator. Clients branch on `(status, code)`.
- `issues` — present on some 400s: Zod validation details (`parsed.error.issues` or `.flatten()` output). Useful for logging, not for branching.
- A few endpoints add context fields (e.g. 413 export adds `count`/`limit`; 422 reopen adds `missing[]`).

When no `code` is present, branch on status alone and treat the failure generically. The web reference falls back to using `error` as a pseudo-code when `code` is absent (`parseErrorCode`) — acceptable for logging, not for logic.

## Status × code table

| Status | `code` | Where (source) | Meaning / client action |
|--------|--------|----------------|-------------------------|
| 400 | — | All routes with Zod bodies (`{error: 'Invalid body'}`, some with `issues`) | Client bug — fix the request; do not retry |
| 400 | — | Flavor gates (`sessions.ts`: wrong-flavor model/mode endpoints) | Hide the control for this flavor |
| 400 | `scratchlist_attachment_invalid`, `scratchlist_entry_empty`, attachment-limit codes from `validateScratchlistAttachmentsForWrite` | `sessions.ts` scratchlist routes | Surface validation message |
| 401 | — | Middleware (`middleware/auth.ts`) and `POST /api/auth` (`routes/auth.ts`) | See [Auth → 401 bodies](./auth.md#401-error-bodies); middleware 401 → silent re-auth once, `/api/auth` 401 → re-pair |
| 403 | — | `guards.ts` (`Session access denied`, `Machine access denied`); owner-only routes (`usage.ts`, `storage.ts`, `hubSettings.ts`, `voice.ts`) | Namespace mismatch / not hub owner — hide the surface, don't retry |
| 403 | `access_denied` | RPC-flow results mapped in `sessions.ts` (resume/reopen/cursor-chat-store) | Same as above |
| 404 | — | `guards.ts` (`Session not found`, `Machine not found`); `permissions.ts` (`Request not found`); scratchlist entry/attachment; `events.ts` visibility (`Subscription not found`) | Stale reference — refresh the parent list |
| 404 | `session_not_found`, `machine_not_found` | Coded variants from resume/reopen/restart-runner result mapping | Same |
| 409 | `session_inactive` | `guards.ts` `requireSession(requireActive)` — send/steer/abort/approve/deny/config on an inactive session | Offer **Reopen** (the web router does exactly this on this code) |
| 409 | `scratchlist_at_cap` | `sessions.ts` scratchlist create (200-entry cap) | Show cap notice; do not retry |
| 409 | `scratchlist_attachment_in_use` | `sessions.ts` attachment delete while still referenced | Detach from entry first |
| 409 | `resume_unavailable` | `sessions.ts` resume/reopen result mapping | Session can't be resumed (e.g. unsupported state) |
| 409 | `metadata_conflict` | `sessions.ts` reopen result mapping | Refetch session, retry once at most |
| 409 | `runner_upgrade_required` | `machines.ts` Agent availability | Upgrade and restart the runner; disable session creation |
| 409 | — (version conflict) | `sessions.ts` PATCH rename/summary, `machines.ts` PATCH rename — message mentions `version`/`concurrently`; **no code** | Concurrent edit — refetch and reapply |
| 409 | — | `sessions.ts` delete-while-active, archive of plain inactive row, fork/rewind refusals, remote-only config on terminal-controlled sessions (`controlledByUser`) | Surface message; refresh session state |
| 413 | — | `sessions.ts` upload (> 50 MB decoded), export too large (`{error, count, limit}`); `voice.ts` transcription (`Audio file too large`, 25 MB audio / ~26 MB body) | Reduce payload |
| 413 | `scratchlist_attachment_too_large` | `sessions.ts` scratchlist upload | Reduce attachment |
| 422 | — | `sessions.ts` reopen with incomplete metadata (`{error, missing[]}`); title-suggestion pass-through (`TitleSuggestionError`, statuses 422/429/502/503) | Not reopenable / feature unavailable |
| 429 | — | Title suggestion (provider rate limit) | Back off |
| 500 | — | Catch-all in most routes (`{error: message}`) | Log; generic failure UI |
| 502 | — | Title suggestion upstream failure; restart-runner unknown error | Retry later |
| 503 | — | `guards.ts` `requireSyncEngine` → `{error: 'Not connected'}` — hub subsystems not up (startup/shutdown window); also Telegram-disabled on `/api/auth` initData path | Retry with backoff |
| 503 | `no_machine_online` | resume/reopen/spawn-flow result mapping (`sessions.ts`) | The machine that owns the session is offline — tell the user to start the runner |
| 503 | `machine_offline` | `machines.ts` restart-runner | Same |
| 503 | `rpc_target_missing` | `machines.ts` pi/codex model catalogs (`RPC_TARGET_MISSING_ERROR_CODE` in `shared/src/rpcMethods.ts` — RPC handler unregistered or socket disconnected) | CLI-side target gone — treat as offline |

## RPC-wrapped endpoints

Many endpoints do not answer from hub state — the hub relays the request over Socket.IO to the session's CLI process (or the machine's runner) and forwards the result: git/file/directory/search, generated images, uploads, model catalogs, Agent availability, slash-commands, skills, spawn, list-directory, paths/exists. (The mode/model/effort config endpoints are RPC-backed too, but map apply-failures to 409 with a message.) Their failure modes differ from plain endpoints:

1. **CLI reachable, command failed** → HTTP **200** with `{success: false, error}` (e.g. `runRpc` in `hub/src/web/routes/git.ts` catches RPC errors, including the 30 s RPC timeout, and returns them as a JSON envelope). Clients must check the `success` field on every RPC-shaped response; HTTP 200 alone means nothing.
2. **CLI offline / handler missing** → depends on the route: the model-catalog routes in `machines.ts` map `RpcTargetMissingError` to **503 `rpc_target_missing`**; `git.ts`-style routes fold it into the 200 `{success: false}` envelope; resume/reopen surface **503 `no_machine_online`**.
3. **Hub subsystems not up** → **503 `Not connected`** from `requireSyncEngine` (brief startup/shutdown window).

Practical rule: treat `success: false`, 503 `rpc_target_missing`, and 503 `no_machine_online` as the same user-facing condition — "the computer running this session is not reachable" — with the raw `error` string available in a details view.

## Retry guidance

| Class | Retry? |
|-------|--------|
| 400 / 403 / 404 / 409 / 413 / 422 | No (fix input, refresh state, or hide surface) |
| 401 (middleware) | Once, after silent re-auth ([Auth](./auth.md#silent-re-auth-401-handling)) |
| 429 / 502 / 503 | Yes, with backoff |
| 200 `{success: false}` | Manual retry only (user-initiated) — the CLI answered and said no |
