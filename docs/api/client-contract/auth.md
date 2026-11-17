# Auth & pairing

How a native client obtains and maintains credentials for one hub. A client may be paired with multiple hubs; everything below is **per hub URL**.

## Credential model

Source of truth: `hub/src/config/cliApiToken.ts`, `hub/src/web/routes/auth.ts`.

| Credential | Lifetime | Where it comes from | What it's for |
|------------|----------|--------------------|---------------|
| **Access token** | Long-lived (until the operator rotates `CLI_API_TOKEN`) | Pairing QR / deeplink, or typed in manually | Exchanged for a JWT via `POST /api/auth`; the client's durable secret |
| **JWT** | 4 hours | Response of `POST /api/auth` | `Authorization: Bearer` on every `/api/*` request |
| **Passkey session** (web and native) | 30 days, and only while its passkey is valid | Native login verification or browser code exchange | Exchanged for a JWT via `POST /api/auth`; never accepted as a bearer token |

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
- Exceptions: `POST /api/auth`, `POST /api/bind`, `GET /api/auth/methods`, `GET /api/auth/cloudflare`, `POST /api/passkey/login/options`, `POST /api/passkey/login/verify`, `POST /api/passkey/browser/login/start`, `POST /api/passkey/browser/complete` and `POST /api/passkey/browser/exchange` do not require a HAPI bearer token. The Cloudflare exchange still requires a valid Access assertion. `GET /health` is outside `/api` and unauthenticated.
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

Source of truth: `shared/src/passkey.ts`, `hub/src/web/routes/passkey.ts`,
`web/src/lib/passkey.ts`, `web/src/passkey-site/`.

Web and native clients use **one RP ID: `auth.hapi.run`**. A credential registered
from either client can sign in to the other, for the **same Hub and namespace**.
The public key and credential-to-namespace mapping stay in that Hub's database;
the official authentication site is static, not an account server.

Set `HAPI_PUBLIC_URL` to the Hub's canonical **HTTPS origin** (no path, query,
credentials, or fragment). The configured origin, never an untrusted proxy Host
header, identifies the Hub. The client must connect through that same origin.
The web app must also use HTTPS and allow the authentication popup. Separately
hosted web apps must have their exact origin in `CORS_ORIGINS`; `*` does not grant
permission to receive authentication callbacks.

### Browser ceremony

1. The initiating tab generates a random state and PKCE verifier; it keeps the
   verifier in memory. Call `POST /api/passkey/browser/login/start` with
   `{codeChallenge, state, callbackOrigin}`. Use
   `POST /api/passkey/browser/register/start` with a JWT for registration; it
   additionally accepts `name`. PKCE is SHA-256/base64url, without padding.
2. The Hub creates a one-time, five-minute transaction and returns `{url}`.
   Open that URL on `https://auth.hapi.run/` in the popup. Its fragment contains
   `{hub, operation, options}` only, never an access token/JWT/verifier.
3. The static page checks the challenge/account's Hub binding, shows the Hub
   address, and calls WebAuthn after user confirmation. It enforces user
   verification and the fixed RP, ignoring untrusted extension choices.
4. The page submits an `application/x-www-form-urlencoded` top-level form to
   the challenge-bound Hub's fixed `POST /api/passkey/browser/complete`, with
   `challenge` and JSON `response` (or `error=cancelled`). No cross-origin API
   fetch or general CORS access from the authentication site is required.
5. The Hub verifies the stored challenge, exact expected origin, signature,
   namespace and token fingerprint. It redirects with 303 to the transaction's
   fixed `<callbackOrigin>/passkey/callback#state=...&code=...` (or `error`).
   Only the canonical Hub origin or an explicitly configured web origin may
   receive this callback; arbitrary return URLs are not supported.
6. The callback clears the fragment and sends the code/state to its opener at
   its own exact origin. The opener checks origin, popup identity and state,
   then calls `POST /api/passkey/browser/exchange {code, verifier}`. Codes expire
   in 60 seconds and are atomically consumed after PKCE validation. Login
   returns `{operation:"login", token, user, passkeySession}`; registration
   returns `{operation:"register"}`. No long-lived token reaches the static site.

Registration authorization is scoped to the JWT namespace and the current
`CLI_API_TOKEN` fingerprint at transaction creation. Rotation during registration
aborts it. Code exchange re-checks credential existence, namespace and token
fingerprint; deletion/rotation cannot revive a pending authorization.

The web stores `passkeySession` under `hapi_passkey_session::<baseUrl>` instead of
an access token. Refresh remains `POST /api/auth {passkeySession}`. Sessions last
30 days while the credential is valid. Deletion revokes them immediately;
rotating `CLI_API_TOKEN` revokes all passkeys and their refresh sessions.

### Shared-RP isolation

The decoded challenge is `{v:1, hub, id, operation, channel, nonce}` with
cryptographically random 32-byte `id` and `nonce` (base64url). `hub` is the
canonical HTTPS Hub origin, `operation` is `login|register`, and `channel` is
`browser|native`. Clients validate these fields **before opening the system
sheet**; the Hub verifies its exact saved challenge and consumes it once.
A malicious Hub cannot proxy another Hub's challenge through the shared RP.

The 64-byte user handle is `SHA-256(hub) || HMAC-SHA256(secret, namespace)` (the
HMAC uses a domain-separated input). Clients validate the Hub prefix before
registration so a malicious Hub cannot overwrite another Hub's account. It is
not a Hub URL discovery mechanism. Login options restrict `allowCredentials` to
this Hub's currently valid shared-RP credentials.

The authentication origin is part of the security boundary. It must contain no
marketing app, third-party scripts, analytics, or service worker. Compromising
that origin compromises the shared browser authentication surface. Existing
credentials using other RP IDs are not supported; register new credentials.

## Native passkeys {#passkeys-native}

Native clients use the same RP/credentials, without a browser redirect:

1. `POST /api/passkey/register/options {client:"native"}` (JWT required),
   validate RP, connected Hub, operation/channel and user-handle prefix, invoke
   the platform API, then `POST /api/passkey/register/verify {response, name}`.
2. `POST /api/passkey/login/options {client:"native"}` (unauthenticated),
   validate RP and challenge binding, invoke the platform API, then
   `POST /api/passkey/login/verify {response}`. `404 no_passkeys` means none of
   this Hub's shared-RP credentials are valid; fall back to the access token.
3. Store `{token, passkeySession}` in secure per-Hub storage and use the normal
   silent re-auth exchange. `401 passkey_session_invalid` is terminal.

Native clients ignore unsupported WebAuthn extensions and enforce user
verification before invoking the platform. iOS offers both platform and roaming
security-key assertion providers, so web-created security-key passkeys are not
restricted to the browser. A credential must be available through the device’s
provider, a synced password manager, or an accessible authenticator.

Direct options/verify routes are native-only; browser-channel challenges cannot
be used there, and native-channel challenges cannot use the browser bridge.
All binary fields are base64url without padding; user verification is required.

- iOS/macOS declares `webcredentials:auth.hapi.run`. The RP's static
  `/.well-known/apple-app-site-association` lists `XJB862F92W.run.hapi.app`.
  Expected client-data origin: `https://auth.hapi.run`.
- Android uses Credential Manager. The RP's static `/.well-known/assetlinks.json`
  grants `delegate_permission/common.get_login_creds` to `run.hapi.companion`
  with the official signing-certificate fingerprint. Expected origin:
  `android:apk-key-hash:<base64url SHA-256 certificate digest>`.
- `HAPI_PASSKEY_NATIVE_ORIGINS` adds explicitly trusted Android signing-certificate
  origins for debug builds. Arbitrary HTTPS origins and per-Hub RP overrides
  are not accepted. Forks change the shared constant, static site and app
  associations together.

Static association sources: `web/passkey-site/.well-known/`. Build with
`bun run build:passkey-site`; deploy **only `website/dist/auth/`** to
`https://auth.hapi.run`, with the supplied security headers. The bridge uses `strict-origin` referrers
(origin only, no request parameters); `no-referrer` would turn Chromium form
POST origins into `null` and is not appropriate for this bridge. It is independent
of the marketing site's `website/dist/public/` output.

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
