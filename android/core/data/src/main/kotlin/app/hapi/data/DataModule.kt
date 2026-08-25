package app.hapi.data

/**
 * Placeholder anchor for the `:core:data` module (B-M0 scaffolding).
 *
 * This module owns transport + persistence and will grow, per the plan
 * (`docs`/plan track B), into:
 *
 * - `HapiApi` -- OkHttp-based REST client for the hub (`/api/auth`, sessions,
 *   messages, permissions, machines, git, scratchlist, transcription, usage,
 *   `/api/devices/register`), with a single-flight `Authenticator` that silently
 *   re-exchanges the stored access token on 401 (JWT expires after 4h).
 * - `SseEngine` -- okhttp-sse subscription to `/api/events` (global + per-session),
 *   `connection-changed {resume: ok|gap}` handshake, `Last-Event-ID` resume,
 *   30s heartbeat / 90s dead-connection detection, 1s->30s backoff with jitter,
 *   gzip streaming decode (fallback `Accept-Encoding: identity`).
 * - Stores -- `StateFlow`-based session-list / session-detail / message-window
 *   stores applying versioned patches from `:core:protocol`, persisted as
 *   `AtomicFile` JSON snapshots (LRU, no database) for instant cold start.
 * - `CredentialStore` -- EncryptedSharedPreferences behind an interface
 *   (per-hub accounts, swappable for a Keystore-backed implementation).
 * - FCM device registration + expedited WorkManager workers that deliver
 *   notification actions (approve/deny/reply) through the authenticated client.
 *
 * Wiring is hand-rolled (no Hilt): `:app`'s `AppGraph` constructs these types.
 */
object DataModule
