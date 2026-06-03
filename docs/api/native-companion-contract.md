# Native companion API contract (phone + Wear)

**Audience:** Implementers of native companion apps (Android phone + Wear OS, iOS, etc.) that pair with a hapi hub via FCM.  
**Auth:** Same JWT as the web client (`POST /api/bind` → `Authorization: Bearer`).

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
  "deviceId": "<stable-install-id-uuid>"
}
```

`platform`: `"phone"` | `"wear"`

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

Hub sends FCM HTTP v1 when Web Push would fire, if FCM is configured and client not visible via SSE (same rule as `PushNotificationChannel`).

### Data payload (all platforms)

| Key | Example | Purpose |
|-----|---------|---------|
| `type` | `ready` | `ready`, `permission-request`, `task-notification`, `session-completed` |
| `sessionId` | uuid | Target session |
| `sessionName` | string | Display name (`agent - project`) |
| `url` | `/sessions/{id}` | Deep link path |
| `requestId` | uuid | Permission only - approve/deny |
| `title` | string | Notification title |
| `body` | string | Notification body |
| `severity` | `info` | `info` (ready), `warning` (permission), `success` / `error` (task) |
| `notifySummary` | JSON string | Optional: parsed `AGENT_NOTIFY_SUMMARY` line from agent text |

Native apps **must** handle `data` for Wear; notification block is for display.

### Client actions (native - not hub)

| User action | Hub API |
|-------------|---------|
| Send text | `POST /api/sessions/:id/messages` `{ "text": "...", "localId": "..." }` |
| Allow | `POST /api/sessions/:id/permissions/:requestId/approve` |
| Deny | `POST /api/sessions/:id/permissions/:requestId/deny` |

`sentFrom` extension (optional future): `android-phone`, `android-wear`.

---

## Environment (hub operator)

```bash
FCM_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
FCM_PROJECT_ID=your-firebase-project-id
```

When unset, hub skips FCM channel (Web Push / Telegram unchanged).

The native push channel is **opt-in**: operators who don't run a companion
app see no behavior change. When at least one device is registered for a
namespace, the existing Web Push channel suppresses its fallback for that
namespace to avoid double-notifying (one in the native app, one from the
PWA service worker). PWA-only operators are unaffected.

---

## Versioning

Contract version **1**. Breaking changes require `data.contractVersion` in FCM payload and doc update.
