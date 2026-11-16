# Auth & pairing

How a native client obtains and maintains credentials for one hub. A client may be paired with multiple hubs; everything below is **per hub URL**.

## Credential model

Source of truth: `hub/src/config/cliApiToken.ts`, `hub/src/web/routes/auth.ts`.

| Credential | Lifetime | Where it comes from | What it's for |
|------------|----------|--------------------|---------------|
| **Access token** | Long-lived (until the operator rotates `CLI_API_TOKEN`) | Pairing QR / deeplink, or typed in manually | Exchanged for a JWT via `POST /api/auth`; the client's durable secret |
| **JWT** | 4 hours | Response of `POST /api/auth` | `Authorization: Bearer` on every `/api/*` request |
| **Passkey session** (web only) | 30 days, and only while its passkey is valid | Response of `POST /api/passkey/login/verify` | Exchanged for a JWT via `POST /api/auth`; never accepted as a bearer token |

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

### Optional Cloudflare Access web exchange

This is a web-only alternative; native pairing continues to use `POST /api/auth`.

- `GET /api/auth/methods` returns `200 {"cloudflareAccess": true|false}` without a HAPI bearer token. It reports capability, not whether the current user is authorized.
- `GET /api/auth/cloudflare` also requires no HAPI bearer token. It requires the current signed `Cf-Access-Jwt-Assertion` supplied by Cloudflare Access and returns the same `AuthResponse` shape as `POST /api/auth`.
- Both responses use `Cache-Control: no-store`. The exchange returns 404 when disabled, 401 for a missing/invalid assertion, 403 `Access denied` for an email outside the configured allowlist, and 503 `Authentication service unavailable` when verification keys cannot be obtained.
- The JWT includes `authMethod: "cloudflareAccess"`, `cfAccessSub` and `cfAccessEmail`, with `ns` from the Hub's email-to-namespace mapping. Its expiry is the earlier of 4 hours and the assertion expiry. Protected REST/SSE requests, terminal handshakes and voice upgrades require a matching current assertion as well as the JWT.
- Web 401 refresh uses this GET exchange instead of a stored access token; scheduled refreshes are spaced at least 15 seconds apart, while forced 401 refresh is immediate. This flow does not provide a native pairing credential.

See [deployment setup](../../guide/deployment.md#cloudflare-access-optional-web-login) for the opt-in Hub environment variables.

## The JWT

Source of truth: `hub/src/web/routes/auth.ts` (signing), `hub/src/web/middleware/auth.ts` (verification), `hub/src/config/jwtSecret.ts` (key).

- HS256, signed with a hub-local 32-byte secret (`<dataDir>/jwt-secret.json`).
- Payload: `{ "uid": <number>, "ns": <string> }` plus standard `iat`/`exp`; Cloudflare-derived sessions also carry the identity-binding fields described above.
- Access-token and Telegram JWTs **expire 4 hours** after issue. Cloudflare-derived JWTs may expire sooner, at the Access assertion expiry.

Treat the token as opaque for auth purposes, but clients may base64url-decode the payload to read `exp` for proactive refresh scheduling (the web client does exactly this — `decodeJwtExpMs` in `web/src/hooks/useAuth.ts`).

## Sending the token

Source of truth: `hub/src/web/middleware/auth.ts`.

- Every `/api/*` request: `Authorization: Bearer <JWT>`.
- Exceptions: `POST /api/auth`, `POST /api/bind`, `GET /api/auth/methods`, `GET /api/auth/cloudflare`, `POST /api/passkey/login/options` and `POST /api/passkey/login/verify` do not require a HAPI bearer token. The Cloudflare exchange still requires a valid Access assertion. `GET /health` is outside `/api` and unauthenticated.
- `GET /api/events` (SSE) **additionally** accepts `?token=<JWT>` as a query param, for HTTP stacks whose EventSource cannot set headers. The header wins when both are present. No other endpoint accepts query-param auth.

## Silent re-auth (401 handling)

Native implementations: iOS `HapiClient/Auth/AuthManager.swift` and
`HapiClient/APIClient.swift`; Android `core/data/.../auth/TokenAuthenticator.kt`.
Web reference: `web/src/api/client.ts` (`request()`),
`web/src/hooks/useAuth.ts` (`refreshAuth`).

For access-token-based clients, the JWT expires every 4 hours, so 401s are routine, not exceptional. The contract:

1. On a 401 from an authenticated client API request, re-exchange the **stored access token** via `POST /api/auth`. The auth exchange itself must not enter this loop.
2. If the exchange succeeds, retry the original request **exactly once** with the new JWT.
3. A 401 from the exchange, or another 401 on the retried request, is terminal: require re-pairing. An exchange rejected with 401 means the stored access token is invalid or revoked.
4. A temporary exchange failure (network error or 5xx) fails the call without signing out or deleting paired credentials. Recover when connectivity returns; do not treat every refresh error as token revocation.

Implementation notes:

- **Single-flight** the refresh: concurrent 401s share an exchange or reuse the JWT already refreshed by another caller. Both native clients implement this.
- Both native clients proactively refresh within 10 minutes of expiry. iOS can retain a still-valid cached JWT after a failed proactive refresh and throttles those attempts for 15 s. Android refreshes before SSE connects and leaves transient failures recoverable.
- The web schedules proactive refresh 60 s before `exp` and on foreground when remaining TTL < 60 s. These scheduling choices are client implementation details, not additional protocol-version requirements. SSE authenticates at connection time, so reconnects need a current token.

## Passkeys (web) {#passkeys-web}

Source of truth: `hub/src/web/routes/passkey.ts`, `hub/src/web/authTokens.ts`, `web/src/lib/passkey.ts`.

The web app can sign in with a WebAuthn passkey instead of pasting the access token. Native apps use the same endpoints with a fixed RP ID; see [Native passkeys](#passkeys-native).

- **Registration needs an existing session.** `POST /api/passkey/register/{options,verify}` require a JWT, so the first sign-in still uses the access token (or Telegram). The passkey is stored with the JWT's namespace and an HMAC fingerprint of the current `CLI_API_TOKEN`.
- **Relying party.** The RP ID is the hostname of the request's `Origin`. The origin must use HTTPS, or HTTP on `localhost`, and must be a domain name rather than an IP address. It must also be trusted: either the same host as the request (the hub-served web app) or an entry in the hub's CORS origins (a wildcard does not count). A passkey only works on the RP ID where it was registered.
- **Sign-in.** `POST /api/passkey/login/options` returns a one-time challenge that expires after 5 minutes. `POST /api/passkey/login/verify` with `{ "response": <AuthenticationResponseJSON> }` requires user verification and returns `{ token, user, passkeySession }`. The web stores `passkeySession` under `hapi_passkey_session::<baseUrl>` instead of an access token, then refreshes with `POST /api/auth { "passkeySession": "..." }`.
- **Revocation.** Rotating `CLI_API_TOKEN` invalidates every passkey and passkey session registered under the old token (`GET /api/passkeys` reports `valid: false`). Deleting a passkey (`DELETE /api/passkeys/:id`) revokes its sessions immediately.

## Native passkeys {#passkeys-native}

Source of truth: `hub/src/web/routes/passkey.ts` (`nativePasskeyConfigFromEnv`), `website/public/.well-known/`.

iOS entitlements and Android asset links are fixed at build time, so they cannot follow a self-hosted hub's domain. The official apps therefore use one shared RP ID, **`hapi.run`**:

- `https://hapi.run/.well-known/apple-app-site-association` lists `webcredentials` for `XJB862F92W.run.hapi.app`. The iOS/macOS app declares `webcredentials:hapi.run` in its Associated Domains entitlement.
- `https://hapi.run/.well-known/assetlinks.json` grants `delegate_permission/common.get_login_creds` to `run.hapi.companion` with its signing-certificate SHA-256.
- Every hub accepts assertions for `hapi.run` only from exact app origins:
  - iOS/macOS (AuthenticationServices): `https://hapi.run`.
  - Android (Credential Manager): `android:apk-key-hash:<base64url SHA-256 of the signing cert>`. Official hashes live in `OFFICIAL_ANDROID_PASSKEY_ORIGINS`.
  - `HAPI_PASSKEY_NATIVE_ORIGINS` (comma-separated) adds origins, e.g. for debug builds. `HAPI_PASSKEY_NATIVE_RP_ID` changes the RP ID for forks that ship their own apps and domain.

  Pages on other `*.hapi.run` hosts can request `hapi.run` assertions, but the hub rejects their origins.

Client flow (same endpoints as the web; natives send no `Origin` header):

1. **Register** (needs a JWT from the normal access-token exchange): `POST /api/passkey/register/options` with `{ "client": "native" }`. The response is WebAuthn `PublicKeyCredentialCreationOptionsJSON` with `rp.id == "hapi.run"`, a base64url `user.id`, and `user.name` of the form `hapi[:<ns>]@<hub host>` so the system picker can tell hubs apart. Create the credential with the platform API, then `POST /api/passkey/register/verify` with `{ "response": <RegistrationResponseJSON>, "name": "<device name>" }`.
2. **Sign in** (no JWT): `POST /api/passkey/login/options` with `{ "client": "native" }`. The response is `PublicKeyCredentialRequestOptionsJSON` whose `allowCredentials` lists this hub's valid native passkeys, so the sheet does not offer other hubs' passkeys. `404 {"error":"no_passkeys"}` means none are registered; fall back to the access token. Then `POST /api/passkey/login/verify` with `{ "response": <AuthenticationResponseJSON> }` returns `{ token, user, passkeySession }`.
3. **Refresh**: store `passkeySession` in secure storage, keyed per hub like the access token. Exchange it with `POST /api/auth { "passkeySession": "..." }` in the normal silent re-auth loop. `401 passkey_session_invalid` is terminal: ask the user to sign in again.

All binary fields are base64url without padding. Registration and sign-in require user verification. Clients should check `rp.id` / `rpId` against their compiled RP ID and refuse a mismatch.

## Namespaces

Source of truth: `hub/src/web/middleware/auth.ts` (sets `namespace` from `ns`), `hub/src/web/routes/guards.ts`, `hub/src/web/routes/{usage,storage,hubSettings,voice}.ts`.

Every request executes in the JWT's namespace (`ns` claim, derived from the access-token suffix or the Cloudflare email mapping). Sessions and machines are namespace-scoped: a session in another namespace answers `403 Session access denied` / `404 Session not found` per the guard logic.

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
| `POST /api/auth` (passkey session) | `{"error": "passkey_session_invalid"}` | Passkey deleted, token rotated, or session expired → sign in again |
| `POST /api/passkey/login/verify` | `{"error": "passkey_revoked"}` | Passkey registered under a rotated `CLI_API_TOKEN` |
| `POST /api/passkey/login/verify` | `{"error": "Passkey challenge expired"}` / `"Unknown passkey"` / `"Passkey verification failed"` | Retry the ceremony; do not loop |

The re-auth loop must distinguish the middleware 401s (recoverable via re-exchange) from the `/api/auth` 401 (terminal — do not loop).

For Cloudflare-derived JWTs, protected requests can also return `403 {"error": "Access denied"}` when the current assertion's email is no longer allowed, or `503 {"error": "Authentication service unavailable"}` when verification keys cannot be obtained. These branches do not apply to legacy token or Telegram JWTs.
