# Native companion API contract (phone + Wear + iOS)

**Audience:** Implementers of native companion apps (Android phone + Wear OS via FCM, iOS via APNs) that pair with a hapi hub.

**Auth:** Exchange the pairing `code` / CLI access token with `POST /api/auth`:
`{ "accessToken": "<code>" }`. Use the returned JWT as `Authorization: Bearer <token>`
for device registration and session actions. `POST /api/bind` is only for Telegram Mini App
binding (requires Telegram `initData`).

## Scope

A companion implementing this contract is a **native client to the same hub the PWA talks to**, surfacing notifications and reply / approve actions on a phone or wearable. The hub may run on the operator's development machine or a separate host; agents execute on their CLI/Runner machines.

---

## Native device registration

### Register

`POST /api/devices/register`

```json
{
  "token": "<fcm-registration-token>",
  "platform": "phone",
  "deviceId": "<stable-install-id>",
  "pushKey": "<base64 of 32 device-generated random bytes>"
}
```

`platform`: `"phone"` | `"wear"` | `"ios"`.

`pushKey`: required for iOS and for Android relay delivery. New Android phone
clients always provide it. Phone registrations without it remain valid for
direct FCM; supplied phone keys must decode to exactly 32 bytes. Wear ignores
this field. The hub canonicalizes and stores phone/iOS keys in the existing
registry; no schema or database version change is required.

`deviceId`: any string of 1-128 characters chosen by the client (does not have to be a UUID). Must be stable across re-registrations of the same install.

**Response:** `{ "ok": true }`

Upsert on `(namespace, deviceId, platform)` - same device re-registering replaces its push token.

### Unregister

`DELETE /api/devices/register`

```json
{
  "token": "<fcm-registration-token>"
}
```

---

## Outbound push (hub → device)

The hub dispatches native notifications independently of PWA visibility.
Android uses direct FCM or an encrypted relay depending on hub configuration;
iOS uses APNs or the encrypted relay. A successful send to at least one native
device sets a per-dispatch gate that suppresses Web Push for that event and
namespace. Missing registrations, missing relay encryption keys, and failed
sends do not suppress the fallback. Provider acceptance is not a handset
receipt.

### Data payload (all platforms)

| Key | Example | Purpose |
|-----|---------|---------|
| `type` | `ready` | `ready`, `permission-request`, `task-notification` |
| `sessionId` | uuid | Target session |
| `sessionName` | string | Display name (`agent - project`) |
| `url` | `/sessions/{id}` | Deep link path |
| `requestId` | uuid | Permission only - approve/deny |
| `title` | string | Notification title |
| `body` | string | Notification body |
| `severity` | `info` | `info` (ready), `warning` (permission), `success` / `error` (task) |
| `contractVersion` | `1` | Present on every message; see [Versioning](#versioning) |
| `notifySummary` | JSON string | Only on `ready`: parsed `AGENT_NOTIFY_SUMMARY` line from agent text, when present |

Direct FCM is data-only. Android relay messages contain the encrypted wrapper
below; after decryption the same data contract drives rendering and actions.

### Client actions (native - not hub)

| User action | Hub API |
|-------------|---------|
| Send text | `POST /api/sessions/:id/messages` `{ "text": "...", "localId": "..." }` |
| Allow | `POST /api/sessions/:id/permissions/:requestId/approve` |
| Deny | `POST /api/sessions/:id/permissions/:requestId/deny` |

`localId` is optional in the send-message body - an opaque client-generated id for reconciling the locally shown message with the server-echoed one.

`sentFrom` extension (optional future): `android-phone`, `android-wear`.

---

## Android relay

The official Android app includes the maintainer's Firebase client
configuration. A current hub without private Firebase credentials sends to
`https://push.hapi.run`; users only pair and allow notifications. Google Play
services and FCM network access are still required. Runtime Firebase project
provisioning and Wear relay delivery are outside this version.

The app persists one `deviceId` and random `pushKey` in a dedicated
Keystore-encrypted preference file, excluded from backup and device transfer.
Registration happens only after persistence succeeds. The first upgrade from
the old DataStore ID registers a new identity; token deduplication removes
the old row. Token rotation preserves the key and ID. Registration fans out
to all paired hubs on start, pairing, token rotation and worker retries.

The hub uses the same [encrypted envelope](#encrypted-envelope) as iOS.
`POST {relayUrl}/v1/push` carries:

```json
{"platform":"android","token":"<opaque FCM token>","envelope":"<base64>","priority":10}
```

FCM sends only string-valued `data: {"hapi_v":"1","hapi_e":"<envelope>"}`,
with Android priority `HIGH` (`NORMAL` for relay priority `5`) and the
configured `restricted_package_name`. No `notification` or `collapse_key`
is sent. The existing FCM default TTL is retained. Android decrypts locally,
then passes the v1 fields to the existing renderer, action workers and
session-open/suppress-when-open logic. A present encrypted marker with an
unknown version, missing key, malformed JSON or failed authentication is
dropped, never interpreted as plaintext. Unwrapped direct-FCM data remains
supported.

The encrypted envelope is capped at 3200 Base64 bytes. If needed, the hub
removes `notifySummary`, then falls back to a minimal `HAPI / New activity`
notification retaining type, session ID, request ID and contract version.
It never truncates ciphertext or action IDs. If even the minimum exceeds the
cap, the send fails and the registration is retained.

Relay `410 unregistered` prunes the token. `413`, `429`, `501`, auth/network
errors and Firebase project mismatch retain it. The relay does not enqueue
or retry sends. The relay and Google see tokens and delivery metadata but
cannot read notification content; the private direct-FCM path retains its
existing plaintext payload.

---

## iOS (APNs)

iOS is a first-class native companion with the **same notification contract**
as Android, delivered over APNs instead of FCM. Like Android relay delivery,
the payload is **end-to-end encrypted**: neither Apple nor the optional hapi push relay
can read notification content (PUSH SPEC v1).

### Registration

`POST /api/devices/register`

```json
{
  "token": "<hex-apns-device-token>",
  "platform": "ios",
  "deviceId": "<stable-install-id>",
  "pushKey": "<base64 of 32 device-generated random bytes>"
}
```

- `token`: the hex-encoded APNs device token from `didRegisterForRemoteNotificationsWithDeviceToken`.
- `pushKey`: **required for `ios`** - 32 random bytes generated on-device
  (e.g. `SecRandomCopyBytes`), base64-encoded. This is the per-device E2E
  encryption key; the hub validates it decodes to exactly 32 bytes and
  rejects the registration otherwise. Keep it in the Keychain (shared with
  the Notification Service Extension via an app group). Rotate it by
  re-registering.
- Upsert on `(namespace, deviceId, platform)`, same as Android. Unregister
  is the same `DELETE /api/devices/register` `{ "token": ... }`.

### Encrypted envelope

The plaintext is the exact [data payload](#data-payload-all-platforms) JSON
(`type`, `sessionId`, `sessionName?`, `url?`, `title`, `body`, `severity?`,
`contractVersion`, `requestId?`, `notifySummary?`), serialized as
**canonical JSON** - recursively sorted object keys, no whitespace, absent
optional fields omitted.

Encryption: **AES-256-GCM** with the device's `pushKey`:

```
envelope = base64( nonce(12 random bytes) || ciphertext || tag(16 bytes) )
AAD      = ASCII "hapi-push-v1"
```

Golden test vector (key `0x00..0x1f`, nonce `0x00..0x0b`):
[`shared/fixtures/push/envelope-v1.json`](https://github.com/tiann/hapi/blob/main/shared/fixtures/push/envelope-v1.json) -
the iOS implementation must reproduce it byte-for-byte.

### APNs request (what the device receives)

```json
{
  "aps": {
    "mutable-content": 1,
    "alert": { "title": "HAPI", "body": "New activity" },
    "sound": "default"
  },
  "hapi": { "v": 1, "e": "<envelope>" }
}
```

The generic `"HAPI / New activity"` alert is the no-decrypt fallback. The
app's **Notification Service Extension** (invoked via `mutable-content: 1`)
decrypts `hapi.e` with the Keychain `pushKey` and replaces title/body with
the real content; `hapi.v` is the envelope version (currently `1`).

Delivery headers: `apns-push-type: alert`, `apns-priority: 10`,
`apns-expiration: 0`, `apns-collapse-id: "<type>-<sessionId>"` (truncated to
64 bytes) - so newer notifications for the same session/type replace older
ones.

### Transports: self-host (direct APNs) vs official relay

The hub picks one of two transports via `HAPI_IOS_PUSH` (or the
`iosPushMode` field in `~/.hapi/settings.json` — every variable below has a
settings.json equivalent, see [Environment](#environment-hub-operator)):

| Mode | Who talks to Apple | Requirements |
|------|--------------------|--------------|
| `relay` (default) | The hapi push relay (`https://push.hapi.run`), which holds the APNs credentials for the official app | none |
| `apns` | The hub itself, over HTTP/2 with an ES256 provider JWT | Apple developer account: `.p8` auth key, key id, team id, bundle id |
| `off` | nobody | - |

```bash
# default: official relay (zero setup)
HAPI_IOS_PUSH=relay
HAPI_PUSH_RELAY_URL=https://push.hapi.run   # override for a self-hosted relay

# self-host: direct APNs, no relay involved
HAPI_IOS_PUSH=apns
APNS_KEY_P8_PATH=/path/to/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=YYYYYYYYYY
APNS_BUNDLE_ID=your.ios.bundle.id
APNS_ENV=production   # or sandbox (Xcode/dev builds)
```

Relay protocol (for self-hosted relays): `POST {relayUrl}/v1/push` with
`{"platform":"ios","token":"<hex>","envelope":"<base64>","collapseId":"...","priority":10}`;
responses `200 {ok:true}`, `410 {ok:false,"code":"unregistered"}` (hub prunes
the device row), `413` / `429` treated as transient.

Dead-token handling mirrors FCM: APNs `410 Unregistered` or
`400 BadDeviceToken` (and relay `410`) unregister the device row; transient
errors (auth, throttle, 5xx, network) never do.

### Privacy

The notification plaintext exists only on the hub and on the paired device.
Apple's push infrastructure and the relay (official or self-hosted) see
**ciphertext plus routing metadata only** (APNs token, collapse id, timing,
size). The `pushKey` never leaves the device except to the operator's own
hub over the authenticated registration call. Operators who prefer zero
third-party involvement beyond Apple run `HAPI_IOS_PUSH=apns`.

Like the FCM channel, iOS push fires unconditionally for registered devices
and suppresses the Web Push fallback for the namespace when a send succeeds
(one OS notification, not two).

---

## Environment (hub operator)

| `HAPI_ANDROID_PUSH` | Behavior |
|---|---|
| `auto` (default) | Configured `FCM_SERVICE_ACCOUNT_PATH`: direct FCM; otherwise official relay |
| `relay` | Force the relay, ignoring private Firebase credentials |
| `fcm` | Require private Firebase credentials, direct phone/Wear delivery |
| `off` | Disable Android/Wear push |

```bash
# Default: no Firebase configuration needed for official Android apps.
HAPI_ANDROID_PUSH=auto
HAPI_PUSH_RELAY_URL=https://push.hapi.run

# Private-project builds must match the service account's Firebase project.
HAPI_ANDROID_PUSH=fcm
FCM_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
```

The Firebase project ID comes from the service-account JSON. Missing/broken
explicit credentials or an unknown Android mode disable the channel with a
diagnostic; they never silently switch private tokens to the official
project. One hub selects one Android transport/project; mixing builds from
different Firebase projects is unsupported. iOS transport selection
(`HAPI_IOS_PUSH`, `APNS_*`) is independent. The push relay does not depend on
whether the hub's network tunnel (`--relay`) is enabled.

Push configuration follows the hub-wide rule (env > `settings.json` >
default; an env value is persisted into `~/.hapi/settings.json` on first
sight, so the variable only has to be passed once). settings.json keys:
`androidPushMode`, `fcmServiceAccountPath`, `iosPushMode`, `iosPushRelayUrl`, `apnsKeyP8Path`,
`apnsKeyId`, `apnsTeamId`, `apnsBundleId`, `apnsEnv`. The historical
`iosPushRelayUrl` setting supplies the shared URL for both platforms. Path
values may use `~`.

The native push channel is **opt-in**: operators who don't run a companion
app see no behavior change. When at least one native send succeeds for a
notification, Web Push suppresses that notification for the namespace
to avoid double-notifying (one in the native app, one from the
PWA service worker). PWA-only operators are unaffected.

---

## Versioning

Contract version **1**. Breaking changes require `data.contractVersion` in FCM payload and doc update.
