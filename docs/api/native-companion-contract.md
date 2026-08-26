# Native companion API contract (phone + Wear + iOS)

**Audience:** Implementers of native companion apps (Android phone + Wear OS via FCM, iOS via APNs) that pair with a hapi hub.

**Auth:** Exchange the pairing `code` / CLI access token with `POST /api/auth`:
`{ "accessToken": "<code>" }`. Use the returned JWT as `Authorization: Bearer <token>`
for device registration and session actions. `POST /api/bind` is only for Telegram Mini App
binding (requires Telegram `initData`).

## Scope

A companion implementing this contract is a **native client to the same hub the PWA talks to**, surfacing notifications and reply / approve actions on a phone or wearable. Hub topology is unchanged - the hub still runs on the operator's dev machine.

---

## Device registration (FCM)

### Register

`POST /api/devices/register`

```json
{
  "token": "<fcm-registration-token>",
  "platform": "phone",
  "deviceId": "<stable-install-id>"
}
```

`platform`: `"phone"` | `"wear"` | `"ios"` (iOS registration adds a required `pushKey` field - see [iOS (APNs)](#ios-apns))

`deviceId`: any string of 1-128 characters chosen by the client (does not have to be a UUID). Must be stable across re-registrations of the same install.

**Response:** `{ "ok": true }`

Upsert on `(namespace, deviceId, platform)` - same device re-registering replaces the FCM token.

### Unregister

`DELETE /api/devices/register`

```json
{
  "token": "<fcm-registration-token>"
}
```

---

## Outbound push (hub → device)

Hub sends FCM HTTP v1 whenever a notification event is emitted for a
namespace with registered native devices and FCM is configured. The native
companion is treated as the canonical wrist-first surface, so FCM fires
**unconditionally** (independent of whether a PWA tab happens to be
foreground / visible via SSE) - that's deliberate, see
`FcmNotificationChannel.deliver()`. Web Push is suppressed for the same
namespace to avoid duplicate OS notifications.

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

Native apps **must** handle `data` for Wear; notification block is for display.

### Client actions (native - not hub)

| User action | Hub API |
|-------------|---------|
| Send text | `POST /api/sessions/:id/messages` `{ "text": "...", "localId": "..." }` |
| Allow | `POST /api/sessions/:id/permissions/:requestId/approve` |
| Deny | `POST /api/sessions/:id/permissions/:requestId/deny` |

`localId` is optional in the send-message body - an opaque client-generated id for reconciling the locally shown message with the server-echoed one.

`sentFrom` extension (optional future): `android-phone`, `android-wear`.

---

## iOS (APNs)

iOS is a first-class native companion with the **same notification contract**
as Android, delivered over APNs instead of FCM - and, unlike FCM, the payload
is **end-to-end encrypted**: neither Apple nor the optional hapi push relay
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
[`shared/fixtures/push/envelope-v1.json`](../../shared/fixtures/push/envelope-v1.json) -
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

```bash
FCM_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
```

The Firebase project id comes from the service-account JSON itself. When
unset, hub skips FCM channel (Web Push / Telegram unchanged). iOS transport
selection (`HAPI_IOS_PUSH`, `APNS_*`) is documented in
[iOS (APNs)](#transports-self-host-direct-apns-vs-official-relay).

Push configuration follows the hub-wide rule (env > `settings.json` >
default; an env value is persisted into `~/.hapi/settings.json` on first
sight, so the variable only has to be passed once). settings.json keys:
`fcmServiceAccountPath`, `iosPushMode`, `iosPushRelayUrl`, `apnsKeyP8Path`,
`apnsKeyId`, `apnsTeamId`, `apnsBundleId`, `apnsEnv`. Path values may use
`~`.

The native push channel is **opt-in**: operators who don't run a companion
app see no behavior change. When at least one device is registered for a
namespace, the existing Web Push channel suppresses its fallback for that
namespace to avoid double-notifying (one in the native app, one from the
PWA service worker). PWA-only operators are unaffected.

---

## Versioning

Contract version **1**. Breaking changes require `data.contractVersion` in FCM payload and doc update.
