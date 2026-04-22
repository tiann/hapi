# Mobile Attention Notifications Design

## Goal

Implement phone-friendly HAPI notifications for events that need the user's attention, without notifying every assistant token, tool log, or ordinary transcript update.

The first version targets HAPI's existing mobile surfaces: the installable PWA and Telegram Mini App-compatible web client. It builds on the current Web Push, service worker, SSE toast, VAPID, and notification hub infrastructure already present in `hub/` and `web/`.

## Non-Goals

- No native iOS or Android app.
- No per-session notification preferences in this iteration.
- No notification for every assistant message.
- No push for tool-call logs, function output, streaming deltas, user messages, or duplicate transcript reconciliation.
- No new third-party notification provider beyond existing Web Push and existing Telegram integration.

## Existing Context

HAPI already has these pieces:

- `web/src/hooks/usePushNotifications.ts` subscribes the browser to Web Push through `PushManager`.
- `web/src/sw.ts` receives push payloads and calls `showNotification`.
- `hub/src/web/routes/push.ts` exposes VAPID public key, subscribe, and unsubscribe endpoints.
- `hub/src/push/pushService.ts` sends Web Push payloads and removes expired subscriptions.
- `hub/src/push/pushNotificationChannel.ts` converts notification hub events into SSE toast or Web Push.
- `hub/src/notifications/notificationHub.ts` already detects permission requests and `ready` events.
- `hub/src/visibility/visibilityTracker.ts` tracks visible web clients so foreground users can get toasts instead of system pushes.

## Notification Scope

Only send notifications for events requiring attention:

1. **Permission request**
   - Trigger: an active session gains a new `agentState.requests` id.
   - Existing behavior stays, with tests preserved.
   - Title: `Permission Request`.
   - Body: session name, plus the tool name when the pending request includes a tool field.
   - Tag: `permission-<sessionId>`.

2. **Ready for input**
   - Trigger: a `message-received` sync event carries an event envelope with `data.type === 'ready'`.
   - Existing behavior stays, with cooldown.
   - Title: `Ready for input`.
   - Body: `<agentName> is waiting in <sessionName>`.
   - Tag: `ready-<sessionId>`.

3. **Session stopped after agent activity**
   - Trigger: an active session transitions from `thinking: true` to `thinking: false`, and the session recently had agent activity.
   - Purpose: cover agents that finish without emitting an explicit `ready` event.
   - Reuses the ready notification channel and payload shape.
   - Suppressed when there is a pending permission request, because permission request gets its own notification.
   - Suppressed by the same ready cooldown to prevent duplicates with explicit `ready` events.

4. **Failure or interruption requiring attention**
   - Trigger: a `message-received` sync event carries an event envelope whose `data.type` is one of:
     - `error`
     - `failed`
     - `aborted`
     - `interrupted`
     - `task-failed`
   - Title: `Task needs attention`.
   - Body: `<sessionName> stopped or failed`.
   - Tag: `attention-<sessionId>`.
   - Uses its own cooldown map so repeated failure events do not spam.

## De-Duping and Noise Control

- Foreground visible clients must receive an SSE toast first.
- If an SSE toast is delivered to a visible client, do not send Web Push.
- If no visible client receives the toast, send Web Push to namespace subscriptions.
- Ready/session-stopped notifications share one cooldown per session.
- Failure/interruption notifications use a separate cooldown per session.
- Permission request notifications keep the existing request-id based debounce.
- Do not notify on:
  - user messages,
  - ordinary assistant text,
  - function calls,
  - function outputs,
  - token counts,
  - session list refreshes,
  - duplicate imported messages.

## Browser and PWA Behavior

The service worker continues to display notifications using the push payload:

- `title`
- `body`
- `icon`
- `badge`
- `tag`
- `data.type`
- `data.sessionId`
- `data.url`

Clicking a notification must navigate to the session URL. If an existing HAPI client window is open, focus it and navigate it to the notification URL. If no window exists, open a new window.

## Subscription UX

Change notification permission from automatic prompting to user-initiated enabling:

- The app may automatically re-subscribe when permission is already `granted`.
- The app must not call `Notification.requestPermission()` automatically on normal startup.
- Settings page must expose current notification state:
  - unsupported,
  - permission `default`,
  - permission `granted`,
  - permission `denied`,
  - subscribed or not subscribed.
- Settings page must provide one explicit button:
  - `Enable notifications` when permission is `default`.
  - `Resubscribe notifications` when permission is `granted` but no subscription is registered.
  - disabled/help text when permission is `denied`.

This fits iOS/Safari and Android browser expectations because permission requests happen inside a user gesture.

## Data Flow

1. CLI or sync source sends session/message updates to hub.
2. Hub's sync engine emits `session-updated`, `session-added`, `session-removed`, or `message-received`.
3. `NotificationHub` evaluates whether the event requires attention.
4. `NotificationHub` calls a `NotificationChannel` method:
   - `sendPermissionRequest(session)`
   - `sendReady(session)`
   - `sendAttention(session, reason)`
5. `PushNotificationChannel` tries SSE toast when namespace has visible clients.
6. If no toast is delivered, `PushService` sends Web Push to stored subscriptions.
7. `web/src/sw.ts` displays the notification.
8. Notification click focuses or opens `/sessions/<sessionId>`.

## API and Type Changes

Extend `NotificationChannel` with a focused attention method:

```ts
export type AttentionReason = 'failed' | 'interrupted'

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendAttention: (session: Session, reason: AttentionReason) => Promise<void>
}
```

`PushPayload.data.type` must accept these values:

- `permission-request`
- `ready`
- `attention`

The external push subscribe API does not change.

## Error Handling

- If a channel throws, log the error and continue with the next channel.
- If a Web Push subscription returns `410`, remove it from storage as today.
- If a Web Push provider fails for another reason, log and continue.
- If notification parsing cannot identify a supported attention event, do nothing.
- If the session is inactive or missing by the time a debounce fires, do nothing.

## Testing Strategy

Use TDD for implementation.

Hub tests:

- `NotificationHub` sends permission notifications only for new request ids.
- `NotificationHub` throttles ready notifications per session.
- `NotificationHub` sends ready when a session transitions from thinking to not thinking after agent activity.
- `NotificationHub` suppresses transition-ready when a pending permission request exists.
- `NotificationHub` sends attention for supported failure/interruption event types.
- `NotificationHub` applies attention cooldown.
- `PushNotificationChannel` sends SSE toast and skips Web Push when a visible client receives the toast.
- `PushNotificationChannel` sends Web Push when no visible client receives the toast.
- `PushNotificationChannel` formats attention payloads correctly.

Web tests:

- `usePushNotifications` reports unsupported browsers.
- `usePushNotifications.subscribe()` posts endpoint and keys.
- Settings page renders permission/subscription state.
- Settings page calls `requestPermission()` only from the explicit enable button.
- `App.tsx` no longer auto-prompts permission on startup, but still auto-subscribes if permission is already granted.

Service worker changes must remain minimal in this iteration. Verification for notification click/focus behavior is the browser/PWA smoke test listed below.

## Rollout and Verification

Implementation verification commands:

```bash
bun run test:hub
bun run test:web
bun run typecheck:hub
bun run typecheck:web
```

Manual smoke test:

1. Start hub and web locally.
2. Open HAPI Web in a browser and enable notifications from settings.
3. Confirm a push subscription is stored in the hub database.
4. Trigger a permission request and confirm either foreground toast or phone notification.
5. Trigger a ready/stop event and confirm notification cooldown prevents duplicates.
6. Click notification and confirm it opens the relevant session route.

## Open Decisions Resolved

- Notification scope is option A: only attention-worthy events.
- First version has no per-session notification preferences.
- Existing Telegram notification behavior remains in place.
- Web Push is the primary phone notification path for PWA.
