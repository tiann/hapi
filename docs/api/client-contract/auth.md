# Auth & pairing

How a native client obtains and maintains credentials for one hub. A client may be paired with multiple hubs; everything below is **per hub URL**.

## Credential model

Source of truth: `hub/src/config/cliApiToken.ts`, `hub/src/web/routes/auth.ts`.

| Credential | Lifetime | Where it comes from | What it's for |
|------------|----------|--------------------|---------------|
| **Access token** | Long-lived (until the operator rotates `CLI_API_TOKEN`) | Pairing QR / deeplink, or typed in manually | Exchanged for a JWT via `POST /api/auth`; the client's durable secret |
| **JWT** | 4 hours | Response of `POST /api/auth` | `Authorization: Bearer` on every `/api/*` request |

The hub's base token (`CLI_API_TOKEN`) is auto-generated on first run (32 random bytes, base64url, ~43 chars) and persisted in the hub's `settings.json`; an operator-provided env token overrides it. The configured base token never contains a `:` — the hub refuses to start otherwise (`validateCliApiToken`).

## Pairing

Source of truth: `hub/src/startHub.ts`, `web/src/components/settings/CompanionPairing.tsx`.

The hub terminal (when started with `--relay`) prints two QR codes; the web app's Settings → Companion pairing screen renders the second one as well:

| QR | Format | Params |
|----|--------|--------|
| Web direct-access | `https://app.hapi.run/?hub=<url>&token=<accessToken>` | `hub`, `token` |
| Companion deeplink | `hapicompanion://bind?hub=<url>&code=<accessToken>` | `hub`, `code` |

Native clients register the `hapicompanion://` scheme and parse `bind` links: `hub` is the hub base URL, `code` is the access token. Note the param-name mismatch: the web QR carries the same value under `token=`, the companion deeplink under `code=`. A robust scanner may accept both forms; the deeplink form is the canonical one for natives. Always provide a manual fallback (type hub URL + access token) for `--relay`-less local hubs.

Both repository apps accept both QR forms in their in-app scanners. Android
requires HTTPS for the hub and web-QR URL, and disables cleartext traffic in
its manifest. iOS parses HTTP and HTTPS URLs, but transport remains subject
to system network policy; its project has no ATS exceptions. Use HTTPS for
the pairing examples. See [Native apps → Pairing](../../guide/native-apps.md#pair-with-your-hub).

Both apps normalize hub identities to `scheme://host[:port]`, lowercasing
scheme/host and removing default ports, paths, queries and fragments. Reverse
proxies must expose the hub at that origin, not solely under a path prefix.
Sources: iOS `HapiClient/Auth/HubRegistry.swift` (`HubURLNormalization`),
Android `core/data/.../auth/HubUrls.kt` and `core/protocol/.../pairing/PairingLinks.kt`.

## Access-token grammar

Source of truth: `hub/src/utils/accessToken.ts`.

```
accessToken = base [":" namespace]
```

- Split on the **last** `:`. No colon → namespace defaults to `"default"`.
- After splitting, both parts must be non-empty and contain no leading/trailing whitespace, else the token is invalid.
- The whole input is trimmed before parsing.

Clients must treat the access token as an **opaque string** and pass it through unchanged to `POST /api/auth` — never split it client-side to "normalize" it. The hub does the splitting; the namespace part selects which sessions the resulting JWT can see (see [Namespaces](#namespaces)).

## Token exchange

Source of truth: `hub/src/web/routes/auth.ts`.

```
POST /api/auth
Content-Type: application/json

{ "accessToken": "<code from pairing>" }
```

Success (200):

```json
{
  "token": "<JWT>",
  "user": { "id": 1, "firstName": "Web User" }
}
```

Failures: `400 {"error": "Invalid body"}`, `401 {"error": "Invalid access token"}`. Request schema: `AuthRequestSchema` in `shared/src/apiTypes.ts` (the `initData` variant is Telegram-only).

`POST /api/bind` (`hub/src/web/routes/bind.ts`) is **Telegram-only** — it binds a Telegram identity to a namespace and requires Telegram `initData`. Native clients never call it.

## The JWT

Source of truth: `hub/src/web/routes/auth.ts` (signing), `hub/src/web/middleware/auth.ts` (verification), `hub/src/config/jwtSecret.ts` (key).

- HS256, signed with a hub-local 32-byte secret (`<dataDir>/jwt-secret.json`).
- Payload: `{ "uid": <number>, "ns": <string> }` plus standard `iat`/`exp`.
- **Expires 4 hours** after issue.

Treat the token as opaque for auth purposes, but clients may base64url-decode the payload to read `exp` for proactive refresh scheduling (the web client does exactly this — `decodeJwtExpMs` in `web/src/hooks/useAuth.ts`).

## Sending the token

Source of truth: `hub/src/web/middleware/auth.ts`.

- Every `/api/*` request: `Authorization: Bearer <JWT>`.
- Exceptions: `/api/auth` and `/api/bind` are unauthenticated; `GET /health` is outside `/api` and unauthenticated.
- `GET /api/events` (SSE) **additionally** accepts `?token=<JWT>` as a query param, for HTTP stacks whose EventSource cannot set headers. The header wins when both are present. No other endpoint accepts query-param auth.

## Silent re-auth (401 handling)

Native implementations: iOS `HapiClient/Auth/AuthManager.swift` and
`HapiClient/APIClient.swift`; Android `core/data/.../auth/TokenAuthenticator.kt`.
Web reference: `web/src/api/client.ts` (`request()`),
`web/src/hooks/useAuth.ts` (`refreshAuth`).

The JWT expires every 4 hours, so 401s are routine, not exceptional. The contract:

1. On a 401 from an authenticated client API request, re-exchange the **stored access token** via `POST /api/auth`. The auth exchange itself must not enter this loop.
2. If the exchange succeeds, retry the original request **exactly once** with the new JWT.
3. A 401 from the exchange, or another 401 on the retried request, is terminal: require re-pairing. An exchange rejected with 401 means the stored access token is invalid or revoked.
4. A temporary exchange failure (network error or 5xx) fails the call without signing out or deleting paired credentials. Recover when connectivity returns; do not treat every refresh error as token revocation.

Implementation notes:

- **Single-flight** the refresh: concurrent 401s share an exchange or reuse the JWT already refreshed by another caller. Both native clients implement this.
- Both native clients proactively refresh within 10 minutes of expiry. iOS can retain a still-valid cached JWT after a failed proactive refresh and throttles those attempts for 15 s. Android refreshes before SSE connects and leaves transient failures recoverable.
- The web schedules proactive refresh 60 s before `exp` and on foreground when remaining TTL < 60 s. These scheduling choices are client implementation details, not additional protocol-version requirements. SSE authenticates at connection time, so reconnects need a current token.

## Namespaces

Source of truth: `hub/src/web/middleware/auth.ts` (sets `namespace` from `ns`), `hub/src/web/routes/guards.ts`, `hub/src/web/routes/{usage,storage,hubSettings,voice}.ts`.

Every request executes in the JWT's namespace (`ns` claim, derived from the access-token suffix). Sessions and machines are namespace-scoped: a session in another namespace answers `403 Session access denied` / `404 Session not found` per the guard logic.

`ns === "default"` is the **hub owner**. Owner-only surfaces (403 for any other namespace):

| Endpoint | Check |
|----------|-------|
| `GET /api/usage/summary` | `hub/src/web/routes/usage.ts` |
| `GET /api/storage/sqlite` | `hub/src/web/routes/storage.ts` |
| `PUT /api/hub-settings` (write; read is open to all namespaces) | `hub/src/web/routes/hubSettings.ts` |
| `GET`/`PUT /api/voice/transcription/credentials` | `hub/src/web/routes/voice.ts` |

Both native apps gate usage/storage screens on the authenticated JWT's `ns`
claim and hide them unless it is `default`; missing claims fail closed. Pass
the access token unchanged during authentication rather than rewriting its
namespace suffix. The hub remains authoritative for every owner-only request.

## Credential storage guidance

- Store the **access token** in platform-secure storage: iOS Keychain, Android `EncryptedSharedPreferences` (behind an interface so the mechanism can be swapped). Never plain files, never logs.
- Key credentials **per hub base URL** (normalized), since a client can pair with several hubs. Web reference: localStorage key `hapi_access_token::<baseUrl>` (`web/src/hooks/useAuth.ts`, `web/src/components/settings/CompanionPairing.tsx`).
- The JWT is a sensitive bearer credential, but need not be persisted: hold it in memory and re-exchange on cold start. If persisted (to save one round-trip at launch), store it alongside the access token with the same protection.
- On unpair/sign-out: delete both credentials, and unregister native push (`DELETE /api/devices/register`) first while you still hold a valid JWT.

## 401 error bodies {#401-error-bodies}

All are JSON with an `error` string; none carry a `code` field except Telegram's `not_bound` (which reuses `error` as the discriminator — natives never see it):

| Origin | Body | Meaning |
|--------|------|---------|
| Middleware, any `/api/*` | `{"error": "Missing authorization token"}` | No bearer header (and no `?token=` on `/api/events`) |
| Middleware, any `/api/*` | `{"error": "Invalid token"}` | JWT signature/expiry verification failed → run silent re-auth |
| Middleware, any `/api/*` | `{"error": "Invalid token payload"}` | JWT valid but payload not `{uid, ns}` (foreign/ancient token) |
| `POST /api/auth` | `{"error": "Invalid access token"}` | Access token wrong or rotated → require re-pairing |
| `POST /api/auth` (Telegram path) | `{"error": "not_bound"}` | Telegram-only; not reachable with `accessToken` auth |

The re-auth loop must distinguish the middleware 401s (recoverable via re-exchange) from the `/api/auth` 401 (terminal — do not loop).
