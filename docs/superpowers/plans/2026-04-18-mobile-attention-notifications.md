# Mobile Attention Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add phone-friendly HAPI notifications for attention-worthy events only: permission requests, ready/finished sessions, and failure/interruption events.

**Architecture:** Extend the existing `NotificationHub` pipeline rather than adding a second notification system. Hub classifies sync events into ready, permission, or attention notifications; `PushNotificationChannel` delivers foreground SSE toasts first and falls back to Web Push; the web app exposes an explicit notification settings control and stops auto-prompting permissions.

**Tech Stack:** Bun, TypeScript, Hono hub, Web Push/VAPID, React 19, Vite PWA, Vitest/Bun tests, Workbox service worker.

---

## File Structure

- Modify: `hub/src/notifications/notificationTypes.ts` — add `AttentionReason`, `NotificationChannel.sendAttention`, and `attentionCooldownMs` option.
- Modify: `hub/src/notifications/eventParsing.ts` — add `extractAttentionReason()` and `isAgentMessageEvent()` helpers.
- Modify: `hub/src/notifications/eventParsing.test.ts` — cover supported failure/interruption event types and ordinary messages.
- Modify: `hub/src/notifications/notificationHub.ts` — track agent activity, thinking transitions, ready cooldown, attention cooldown, and channel dispatch.
- Modify: `hub/src/notifications/notificationHub.test.ts` — add TDD coverage for transition-ready, permission suppression, attention events, and cooldown.
- Create: `hub/src/push/pushNotificationChannel.test.ts` — cover foreground toast vs Web Push fallback and attention payload formatting.
- Modify: `hub/src/push/pushNotificationChannel.ts` — add `sendAttention()` and shared foreground-toast delivery helper.
- Modify: `hub/src/push/pushService.ts` — narrow `PushPayload.data.type` to notification payload types.
- Create: `web/src/hooks/useAutoPushSubscription.ts` — isolate startup auto-subscribe behavior; it subscribes only when permission is already granted.
- Create: `web/src/hooks/useAutoPushSubscription.test.tsx` — verify startup behavior never requests permission.
- Modify: `web/src/App.tsx` — replace auto permission prompt effect with `useAutoPushSubscription()`.
- Modify: `web/src/hooks/usePushNotifications.ts` — expose `refreshSubscription` so settings can update state after enable/resubscribe.
- Create: `web/src/hooks/usePushNotifications.test.tsx` — test unsupported and successful subscribe flows.
- Modify: `web/src/routes/settings/index.tsx` — add Notifications section using `useAppContext()` and `usePushNotifications()`.
- Modify: `web/src/routes/settings/index.test.tsx` — mock app context and push hook; verify notification state and explicit button behavior.
- Modify: `web/src/lib/locales/en.ts` and `web/src/lib/locales/zh-CN.ts` — add notification settings labels.
- Modify: `web/src/sw.ts` — focus an existing HAPI client and navigate it on notification click before opening a new window.

## Spec Coverage Map

- Permission requests: Task 2 keeps the existing `sendPermissionRequest()` hub flow and Task 3 keeps the `permission-request` payload path when shared delivery is introduced.
- Ready/finished sessions: Task 2 sends `sendReady()` both for existing ready events and for the new thinking-stops-after-agent-activity transition.
- Failure/interruption events: Tasks 1–3 add `AttentionReason`, parse supported event types, and deliver `sendAttention()` through SSE toast first, then fall back to Web Push when no visible client receives the toast.
- Mobile opt-in: Task 4 removes startup permission prompts; startup auto-subscribe only runs when `permission === 'granted'`, while Task 5 adds the explicit Settings button that calls `requestPermission()`.
- Notification click navigation: Task 6 updates the service worker to focus an existing HAPI window and navigate it before opening a new one.

## Task 1: Hub Notification Types and Event Parsing

**Files:**
- Modify: `hub/src/notifications/notificationTypes.ts`
- Modify: `hub/src/notifications/eventParsing.ts`
- Modify: `hub/src/notifications/eventParsing.test.ts`

- [ ] **Step 1: Write failing parser/type tests**

Append these tests to `hub/src/notifications/eventParsing.test.ts` inside the existing `describe('extractMessageEventType', () => { ... })` block, after the current tests:

```ts
    it('returns attention reason for supported failure and interruption event types', () => {
        const makeEvent = (type: string): SyncEvent => ({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: `message-${type}`,
                seq: 10,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        id: `event-${type}`,
                        type: 'event',
                        data: { type }
                    }
                }
            }
        })

        expect(extractAttentionReason(makeEvent('error'))).toBe('failed')
        expect(extractAttentionReason(makeEvent('failed'))).toBe('failed')
        expect(extractAttentionReason(makeEvent('task-failed'))).toBe('failed')
        expect(extractAttentionReason(makeEvent('aborted'))).toBe('interrupted')
        expect(extractAttentionReason(makeEvent('interrupted'))).toBe('interrupted')
    })

    it('returns null attention reason for ready and ordinary message events', () => {
        const readyEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-ready',
                seq: 11,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        id: 'event-ready',
                        type: 'event',
                        data: { type: 'ready' }
                    }
                }
            }
        }

        const textEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-text',
                seq: 12,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: { type: 'text', text: 'done' }
                }
            }
        }

        expect(extractAttentionReason(readyEvent)).toBeNull()
        expect(extractAttentionReason(textEvent)).toBeNull()
    })

    it('detects agent message events without treating user messages as agent activity', () => {
        const agentEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-message',
                seq: 13,
                localId: null,
                createdAt: 0,
                content: { role: 'agent', content: { type: 'text', text: 'done' } }
            }
        }
        const userEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'user-message',
                seq: 14,
                localId: null,
                createdAt: 0,
                content: { role: 'user', content: { type: 'text', text: 'hello' } }
            }
        }

        expect(isAgentMessageEvent(agentEvent)).toBe(true)
        expect(isAgentMessageEvent(userEvent)).toBe(false)
    })
```

Also update the import line in `eventParsing.test.ts` to:

```ts
import { extractAttentionReason, extractMessageEventType, isAgentMessageEvent } from './eventParsing'
```

- [ ] **Step 2: Run parser tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/notifications/eventParsing.test.ts
```

Expected: FAIL because `extractAttentionReason` and `isAgentMessageEvent` are not exported.

- [ ] **Step 3: Implement notification types and parsing helpers**

Replace `hub/src/notifications/notificationTypes.ts` with:

```ts
import type { Session } from '../sync/syncEngine'

export type AttentionReason = 'failed' | 'interrupted'

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendAttention: (session: Session, reason: AttentionReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
    attentionCooldownMs?: number
}
```

Replace `hub/src/notifications/eventParsing.ts` with:

```ts
import { isObject } from '@hapi/protocol'
import type { SyncEvent } from '../sync/syncEngine'
import type { AttentionReason } from './notificationTypes'

type EventEnvelope = {
    type?: unknown
    data?: unknown
}

function extractEventEnvelope(message: unknown): EventEnvelope | null {
    if (!isObject(message)) {
        return null
    }

    if (message.type === 'event') {
        return message as EventEnvelope
    }

    const content = message.content
    if (!isObject(content) || content.type !== 'event') {
        return null
    }

    return content as EventEnvelope
}

function extractMessageContent(event: SyncEvent): unknown {
    if (event.type !== 'message-received') {
        return null
    }
    return event.message?.content
}

export function extractMessageEventType(event: SyncEvent): string | null {
    const envelope = extractEventEnvelope(extractMessageContent(event))
    if (!envelope) {
        return null
    }

    const data = isObject(envelope.data) ? envelope.data : null
    const eventType = data?.type
    return typeof eventType === 'string' ? eventType : null
}

export function extractAttentionReason(event: SyncEvent): AttentionReason | null {
    const eventType = extractMessageEventType(event)
    if (eventType === 'error' || eventType === 'failed' || eventType === 'task-failed') {
        return 'failed'
    }
    if (eventType === 'aborted' || eventType === 'interrupted') {
        return 'interrupted'
    }
    return null
}

export function isAgentMessageEvent(event: SyncEvent): boolean {
    const content = extractMessageContent(event)
    if (!isObject(content)) {
        return false
    }
    return content.role === 'agent'
}
```

- [ ] **Step 4: Run parser tests to verify GREEN**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/notifications/eventParsing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit parser/type changes**

Run:

```bash
git add hub/src/notifications/notificationTypes.ts hub/src/notifications/eventParsing.ts hub/src/notifications/eventParsing.test.ts
git commit -m "feat: classify attention notification events"
```

## Task 2: NotificationHub Attention Logic

**Files:**
- Modify: `hub/src/notifications/notificationHub.ts`
- Modify: `hub/src/notifications/notificationHub.test.ts`

- [ ] **Step 1: Write failing NotificationHub tests**

Update `StubChannel` in `hub/src/notifications/notificationHub.test.ts` to track attention notifications:

```ts
class StubChannel implements NotificationChannel {
    readonly readySessions: Session[] = []
    readonly permissionSessions: Session[] = []
    readonly attentionNotifications: Array<{ session: Session; reason: 'failed' | 'interrupted' }> = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        this.permissionSessions.push(session)
    }

    async sendAttention(session: Session, reason: 'failed' | 'interrupted'): Promise<void> {
        this.attentionNotifications.push({ session, reason })
    }
}
```

Append these tests inside the existing `describe('NotificationHub', () => { ... })` block:

```ts
    it('sends ready when thinking stops after agent activity', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 5
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-text',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'text', text: 'done' } }
            }
        })

        engine.setSession(createSession({ thinking: false, thinkingAt: 3 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        await sleep(10)

        expect(channel.readySessions).toHaveLength(1)
        hub.stop()
    })

    it('does not send transition-ready when a permission request is pending', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 5,
            readyCooldownMs: 5
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-text',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'text', text: 'needs approval' } }
            }
        })
        engine.setSession(createSession({
            thinking: false,
            thinkingAt: 3,
            agentState: {
                requests: {
                    req1: { tool: 'Edit', arguments: {}, createdAt: 3 }
                }
            }
        }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        await sleep(20)

        expect(channel.readySessions).toHaveLength(0)
        expect(channel.permissionSessions).toHaveLength(1)
        hub.stop()
    })

    it('sends attention notification for failure and interruption events with cooldown', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 1,
            attentionCooldownMs: 20
        })
        engine.setSession(createSession())

        const failedEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'failed-1',
                seq: 4,
                localId: null,
                createdAt: 4,
                content: { role: 'agent', content: { type: 'event', data: { type: 'failed' } } }
            }
        }

        engine.emit(failedEvent)
        await sleep(5)
        engine.emit(failedEvent)
        await sleep(5)

        expect(channel.attentionNotifications).toHaveLength(1)
        expect(channel.attentionNotifications[0]?.reason).toBe('failed')

        await sleep(25)
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'aborted-1',
                seq: 5,
                localId: null,
                createdAt: 5,
                content: { role: 'agent', content: { type: 'event', data: { type: 'aborted' } } }
            }
        })
        await sleep(5)

        expect(channel.attentionNotifications).toHaveLength(2)
        expect(channel.attentionNotifications[1]?.reason).toBe('interrupted')
        hub.stop()
    })
```

- [ ] **Step 2: Run NotificationHub tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/notifications/notificationHub.test.ts
```

Expected: FAIL because `NotificationHub` does not call `sendAttention()` and does not detect thinking transitions.

- [ ] **Step 3: Implement NotificationHub state and dispatch**

Modify `hub/src/notifications/notificationHub.ts` as follows:

- Change imports to:

```ts
import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { AttentionReason, NotificationChannel, NotificationHubOptions } from './notificationTypes'
import { extractAttentionReason, extractMessageEventType, isAgentMessageEvent } from './eventParsing'
```

- Add class fields near the existing maps:

```ts
    private readonly attentionCooldownMs: number
    private readonly lastAttentionNotificationAt: Map<string, number> = new Map()
    private readonly lastThinkingBySession: Map<string, boolean> = new Map()
    private readonly agentActivityBySession: Map<string, boolean> = new Map()
```

- In the constructor, set:

```ts
        this.attentionCooldownMs = options?.attentionCooldownMs ?? 5000
```

- In `stop()` and `clearSessionState()`, clear the three new maps for the relevant session/all sessions.

- Replace the `session-updated` / `session-added` branch in `handleSyncEvent()` with this logic:

```ts
        if ((event.type === 'session-updated' || event.type === 'session-added') && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session || !session.active) {
                this.clearSessionState(event.sessionId)
                return
            }

            this.checkForPermissionNotification(session)
            this.checkForThinkingStoppedNotification(session)
            this.lastThinkingBySession.set(session.id, session.thinking)
            return
        }
```

- Replace the `message-received` branch with this logic:

```ts
        if (event.type === 'message-received' && event.sessionId) {
            if (isAgentMessageEvent(event)) {
                this.agentActivityBySession.set(event.sessionId, true)
            }

            const attentionReason = extractAttentionReason(event)
            if (attentionReason) {
                this.sendAttentionNotification(event.sessionId, attentionReason).catch((error) => {
                    console.error('[NotificationHub] Failed to send attention notification:', error)
                })
                return
            }

            const eventType = extractMessageEventType(event)
            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[NotificationHub] Failed to send ready notification:', error)
                })
            }
        }
```

- Add these private methods before `notifyReady()`:

```ts
    private hasPendingPermissionRequest(session: Session): boolean {
        const requests = session.agentState?.requests
        return Boolean(requests && Object.keys(requests).length > 0)
    }

    private checkForThinkingStoppedNotification(session: Session): void {
        const wasThinking = this.lastThinkingBySession.get(session.id)
        if (wasThinking !== true || session.thinking) {
            return
        }
        if (!this.agentActivityBySession.get(session.id)) {
            return
        }
        this.agentActivityBySession.delete(session.id)
        if (this.hasPendingPermissionRequest(session)) {
            return
        }

        this.sendReadyNotification(session.id).catch((error) => {
            console.error('[NotificationHub] Failed to send ready notification:', error)
        })
    }

    private async sendAttentionNotification(sessionId: string, reason: AttentionReason): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastAttentionNotificationAt.get(sessionId) ?? 0
        if (now - last < this.attentionCooldownMs) {
            return
        }
        this.lastAttentionNotificationAt.set(sessionId, now)

        await this.notifyAttention(session, reason)
    }
```

- Add `notifyAttention()` after `notifyPermission()`:

```ts
    private async notifyAttention(session: Session, reason: AttentionReason): Promise<void> {
        for (const channel of this.channels) {
            try {
                await channel.sendAttention(session, reason)
            } catch (error) {
                console.error('[NotificationHub] Failed to send attention notification:', error)
            }
        }
    }
```

- [ ] **Step 4: Run NotificationHub tests to verify GREEN**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/notifications/notificationHub.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit NotificationHub changes**

Run:

```bash
git add hub/src/notifications/notificationHub.ts hub/src/notifications/notificationHub.test.ts
git commit -m "feat: notify when sessions need attention"
```

## Task 3: Push Notification Channel Delivery and Payloads

**Files:**
- Create: `hub/src/push/pushNotificationChannel.test.ts`
- Modify: `hub/src/push/pushNotificationChannel.ts`
- Modify: `hub/src/push/pushService.ts`

- [ ] **Step 1: Write failing PushNotificationChannel tests**

Create `hub/src/push/pushNotificationChannel.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload, PushService } from './pushService'
import type { Session } from '../sync/syncEngine'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

type ToastEvent = {
    type: 'toast'
    data: {
        title: string
        body: string
        sessionId: string
        url: string
    }
}

class FakePushService {
    readonly sent: Array<{ namespace: string; payload: PushPayload }> = []

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        this.sent.push({ namespace, payload })
    }
}

class FakeSSEManager {
    readonly toasts: Array<{ namespace: string; event: ToastEvent }> = []
    delivered = 0

    async sendToast(namespace: string, event: ToastEvent): Promise<number> {
        this.toasts.push({ namespace, event })
        return this.delivered
    }
}

class FakeVisibilityTracker {
    visible = false

    hasVisibleConnection(_namespace: string): boolean {
        return this.visible
    }
}

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/repo', host: 'mac', summary: { text: 'Build UI', updatedAt: 1 } },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    }
}

function createChannel() {
    const push = new FakePushService()
    const sse = new FakeSSEManager()
    const visibility = new FakeVisibilityTracker()
    const channel = new PushNotificationChannel(
        push as unknown as PushService,
        sse as unknown as SSEManager,
        visibility as unknown as VisibilityTracker,
        ''
    )
    return { channel, push, sse, visibility }
}

describe('PushNotificationChannel', () => {
    it('sends foreground toast and skips Web Push when visible toast is delivered', async () => {
        const { channel, push, sse, visibility } = createChannel()
        visibility.visible = true
        sse.delivered = 1

        await channel.sendReady(createSession())

        expect(sse.toasts).toHaveLength(1)
        expect(sse.toasts[0]?.event.data.title).toBe('Ready for input')
        expect(push.sent).toHaveLength(0)
    })

    it('falls back to Web Push when there is no visible delivered toast', async () => {
        const { channel, push, sse, visibility } = createChannel()
        visibility.visible = true
        sse.delivered = 0

        await channel.sendReady(createSession())

        expect(sse.toasts).toHaveLength(1)
        expect(push.sent).toHaveLength(1)
        expect(push.sent[0]?.payload.data?.type).toBe('ready')
    })

    it('formats attention notification payloads', async () => {
        const { channel, push } = createChannel()

        await channel.sendAttention(createSession(), 'failed')

        expect(push.sent).toHaveLength(1)
        expect(push.sent[0]?.payload).toEqual({
            title: 'Task needs attention',
            body: 'Build UI stopped or failed',
            tag: 'attention-session-1',
            data: {
                type: 'attention',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        })
    })
})
```

- [ ] **Step 2: Run PushNotificationChannel tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/push/pushNotificationChannel.test.ts
```

Expected: FAIL because `sendAttention()` does not exist.

- [ ] **Step 3: Implement attention payload and shared delivery helper**

In `hub/src/push/pushService.ts`, replace the `PushPayload` type with:

```ts
export type PushPayload = {
    title: string
    body: string
    tag?: string
    data?: {
        type: 'permission-request' | 'ready' | 'attention'
        sessionId: string
        url: string
    }
}
```

In `hub/src/push/pushNotificationChannel.ts`:

- Change the type import to:

```ts
import type { AttentionReason, NotificationChannel } from '../notifications/notificationTypes'
```

- Replace repeated toast/push delivery code by adding this private helper before `buildSessionPath()`:

```ts
    private async deliver(session: Session, payload: PushPayload): Promise<void> {
        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }
```

- In `sendPermissionRequest()` and `sendReady()`, replace the local toast/push block with:

```ts
        await this.deliver(session, payload)
```

- Add this method after `sendReady()`:

```ts
    async sendAttention(session: Session, _reason: AttentionReason): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const payload: PushPayload = {
            title: 'Task needs attention',
            body: `${name} stopped or failed`,
            tag: `attention-${session.id}`,
            data: {
                type: 'attention',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.deliver(session, payload)
    }
```

- [ ] **Step 4: Run PushNotificationChannel tests to verify GREEN**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test hub/src/push/pushNotificationChannel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run hub typecheck for channel interface compatibility**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run typecheck:hub
```

Expected: PASS.

- [ ] **Step 6: Commit push channel changes**

Run:

```bash
git add hub/src/push/pushNotificationChannel.ts hub/src/push/pushNotificationChannel.test.ts hub/src/push/pushService.ts
git commit -m "feat: deliver attention push notifications"
```

## Task 4: Web Push Hook Tests and Startup Auto-Subscribe

**Files:**
- Create: `web/src/hooks/usePushNotifications.test.tsx`
- Create: `web/src/hooks/useAutoPushSubscription.ts`
- Create: `web/src/hooks/useAutoPushSubscription.test.tsx`
- Modify: `web/src/hooks/usePushNotifications.ts`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Write failing `usePushNotifications` tests**

Create `web/src/hooks/usePushNotifications.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { usePushNotifications } from './usePushNotifications'

function installUnsupportedPushGlobals() {
    Reflect.deleteProperty(window.navigator, 'serviceWorker')
    Reflect.deleteProperty(window, 'PushManager')
    Reflect.deleteProperty(window, 'Notification')
}

function installSupportedPushGlobals(options?: { permission?: NotificationPermission }) {
    const permission = options?.permission ?? 'granted'
    const subscriptionJson = {
        endpoint: 'https://push.example/subscription',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
    }
    const subscription = {
        endpoint: subscriptionJson.endpoint,
        toJSON: () => subscriptionJson,
        unsubscribe: vi.fn(async () => true)
    }
    const pushManager = {
        getSubscription: vi.fn(async () => null),
        subscribe: vi.fn(async () => subscription)
    }
    const ready = Promise.resolve({ pushManager })

    Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: { ready }
    })
    Object.defineProperty(window, 'PushManager', {
        configurable: true,
        value: function PushManager() {}
    })
    Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: {
            permission,
            requestPermission: vi.fn(async () => permission)
        }
    })

    return { pushManager, subscription }
}

function createApi(): ApiClient & {
    subscribed: unknown[]
} {
    const subscribed: unknown[] = []
    return {
        subscribed,
        getPushVapidPublicKey: vi.fn(async () => ({ publicKey: 'AQAB' })),
        subscribePushNotifications: vi.fn(async (payload: unknown) => {
            subscribed.push(payload)
        }),
        unsubscribePushNotifications: vi.fn(async () => {})
    } as unknown as ApiClient & { subscribed: unknown[] }
}

describe('usePushNotifications', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        installUnsupportedPushGlobals()
    })

    it('reports unsupported browsers and exposes refreshSubscription', async () => {
        const { result } = renderHook(() => usePushNotifications(null))

        await waitFor(() => {
            expect(result.current.isSupported).toBe(false)
            expect(result.current.isSubscribed).toBe(false)
        })
        expect(typeof result.current.refreshSubscription).toBe('function')
    })

    it('subscribes and posts endpoint keys when permission is granted', async () => {
        const { pushManager } = installSupportedPushGlobals({ permission: 'granted' })
        const api = createApi()
        const { result } = renderHook(() => usePushNotifications(api))

        await act(async () => {
            const ok = await result.current.subscribe()
            expect(ok).toBe(true)
        })

        expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
        expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: 'https://push.example/subscription',
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        })
        expect(result.current.isSubscribed).toBe(true)
    })
})
```

- [ ] **Step 2: Run hook tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test web/src/hooks/usePushNotifications.test.tsx
```

Expected: FAIL because `refreshSubscription` is not returned from `usePushNotifications()`.

- [ ] **Step 3: Expose `refreshSubscription` from `usePushNotifications`**

In `web/src/hooks/usePushNotifications.ts`, add `refreshSubscription` to the returned object:

```ts
    return {
        isSupported,
        permission,
        isSubscribed,
        refreshSubscription,
        requestPermission,
        subscribe,
        unsubscribe
    }
```

- [ ] **Step 4: Write failing auto-subscribe hook tests**

Create `web/src/hooks/useAutoPushSubscription.ts` with this initial exported type only:

```ts
import type { ApiClient } from '@/api/client'

export type AutoPushSubscriptionOptions = {
    api: ApiClient | null
    token: string | null
    isTelegram: boolean
    isSupported: boolean
    permission: NotificationPermission
    subscribe: () => Promise<boolean>
}
```

Create `web/src/hooks/useAutoPushSubscription.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutoPushSubscription } from './useAutoPushSubscription'

describe('useAutoPushSubscription', () => {
    it('subscribes automatically only when permission is already granted', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: false,
            isSupported: true,
            permission: 'granted',
            subscribe
        }))

        await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
    })

    it('does not request or subscribe when permission is default', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: false,
            isSupported: true,
            permission: 'default',
            subscribe
        }))

        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(subscribe).not.toHaveBeenCalled()
    })

    it('does not subscribe inside Telegram', async () => {
        const subscribe = vi.fn(async () => true)

        renderHook(() => useAutoPushSubscription({
            api: {} as never,
            token: 'token',
            isTelegram: true,
            isSupported: true,
            permission: 'granted',
            subscribe
        }))

        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(subscribe).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 5: Run auto-subscribe tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test web/src/hooks/useAutoPushSubscription.test.tsx
```

Expected: FAIL because `useAutoPushSubscription` is not exported.

- [ ] **Step 6: Implement `useAutoPushSubscription`**

Replace `web/src/hooks/useAutoPushSubscription.ts` with:

```ts
import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'

export type AutoPushSubscriptionOptions = {
    api: ApiClient | null
    token: string | null
    isTelegram: boolean
    isSupported: boolean
    permission: NotificationPermission
    subscribe: () => Promise<boolean>
}

export function useAutoPushSubscription(options: AutoPushSubscriptionOptions): void {
    const attemptedRef = useRef(false)

    useEffect(() => {
        if (!options.api || !options.token) {
            attemptedRef.current = false
            return
        }
        if (options.isTelegram || !options.isSupported || options.permission !== 'granted') {
            return
        }
        if (attemptedRef.current) {
            return
        }
        attemptedRef.current = true

        void options.subscribe()
    }, [
        options.api,
        options.isSupported,
        options.isTelegram,
        options.permission,
        options.subscribe,
        options.token
    ])
}
```

- [ ] **Step 7: Integrate the hook in App without automatic permission prompting**

In `web/src/App.tsx`:

- Add import:

```ts
import { useAutoPushSubscription } from '@/hooks/useAutoPushSubscription'
```

- Remove `pushPromptedRef`.
- Change the push hook destructuring to:

```ts
    const { isSupported: isPushSupported, permission: pushPermission, subscribe } = usePushNotifications(api)
```

- Replace the whole push `useEffect` block with:

```ts
    useAutoPushSubscription({
        api,
        token,
        isTelegram: isTelegramApp(),
        isSupported: isPushSupported,
        permission: pushPermission,
        subscribe
    })
```

- [ ] **Step 8: Run web hook tests to verify GREEN**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test web/src/hooks/usePushNotifications.test.tsx web/src/hooks/useAutoPushSubscription.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit web hook and App changes**

Run:

```bash
git add web/src/hooks/usePushNotifications.ts web/src/hooks/usePushNotifications.test.tsx web/src/hooks/useAutoPushSubscription.ts web/src/hooks/useAutoPushSubscription.test.tsx web/src/App.tsx
git commit -m "feat: make push subscription user initiated"
```

## Task 5: Notification Settings UI

**Files:**
- Modify: `web/src/routes/settings/index.tsx`
- Modify: `web/src/routes/settings/index.test.tsx`
- Modify: `web/src/lib/locales/en.ts`
- Modify: `web/src/lib/locales/zh-CN.ts`

- [ ] **Step 1: Write failing settings tests**

In `web/src/routes/settings/index.test.tsx`:

- Add import:

```ts
import { fireEvent, waitFor } from '@testing-library/react'
```

- Add mocks near existing mocks:

```ts
const mockRequestPermission = vi.fn(async () => true)
const mockSubscribe = vi.fn(async () => true)
const mockRefreshSubscription = vi.fn(async () => {})
let mockPushState = {
    isSupported: true,
    permission: 'default' as NotificationPermission,
    isSubscribed: false
}

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {}, token: 'token', baseUrl: 'http://localhost' })
}))

vi.mock('@/hooks/usePushNotifications', () => ({
    usePushNotifications: () => ({
        ...mockPushState,
        requestPermission: mockRequestPermission,
        subscribe: mockSubscribe,
        refreshSubscription: mockRefreshSubscription,
        unsubscribe: vi.fn(async () => true)
    })
}))
```

- In `beforeEach()`, reset push state:

```ts
        mockPushState = {
            isSupported: true,
            permission: 'default',
            isSubscribed: false
        }
        mockRequestPermission.mockClear()
        mockSubscribe.mockClear()
        mockRefreshSubscription.mockClear()
```

- Append tests inside `describe('SettingsPage', () => { ... })`:

```tsx
    it('renders notification settings state and enable button', () => {
        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Notifications').length).toBeGreaterThanOrEqual(1)
        expect(screen.getAllByText('Not enabled').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeInTheDocument()
    })

    it('enables notifications only after clicking the explicit button', async () => {
        renderWithProviders(<SettingsPage />)

        expect(mockRequestPermission).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))

        await waitFor(() => expect(mockRequestPermission).toHaveBeenCalledTimes(1))
        await waitFor(() => expect(mockSubscribe).toHaveBeenCalledTimes(1))
    })

    it('renders resubscribe button when permission is granted but subscription is missing', () => {
        mockPushState = {
            isSupported: true,
            permission: 'granted',
            isSubscribed: false
        }

        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Permission granted, not subscribed').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('button', { name: 'Resubscribe notifications' })).toBeInTheDocument()
    })

    it('shows help text when notification permission is denied', () => {
        mockPushState = {
            isSupported: true,
            permission: 'denied',
            isSubscribed: false
        }

        renderWithProviders(<SettingsPage />)

        expect(screen.getAllByText('Blocked by browser settings').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByText('Enable notifications from browser or system settings, then return here.')).toBeInTheDocument()
    })
```

- [ ] **Step 2: Run settings tests to verify RED**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test web/src/routes/settings/index.test.tsx
```

Expected: FAIL because the notifications section does not exist.

- [ ] **Step 3: Add locale keys**

Add these keys near the settings keys in `web/src/lib/locales/en.ts`:

```ts
  'settings.notifications.title': 'Notifications',
  'settings.notifications.status': 'Notification Status',
  'settings.notifications.unsupported': 'Not supported in this browser',
  'settings.notifications.default': 'Not enabled',
  'settings.notifications.grantedSubscribed': 'Enabled',
  'settings.notifications.grantedUnsubscribed': 'Permission granted, not subscribed',
  'settings.notifications.denied': 'Blocked by browser settings',
  'settings.notifications.enable': 'Enable notifications',
  'settings.notifications.resubscribe': 'Resubscribe notifications',
  'settings.notifications.deniedHelp': 'Enable notifications from browser or system settings, then return here.',
  'settings.notifications.unsupportedHelp': 'Use Safari on iOS or a browser with Web Push support.',
```

Add these keys near the settings keys in `web/src/lib/locales/zh-CN.ts`:

```ts
  'settings.notifications.title': '通知',
  'settings.notifications.status': '通知状态',
  'settings.notifications.unsupported': '当前浏览器不支持',
  'settings.notifications.default': '未启用',
  'settings.notifications.grantedSubscribed': '已启用',
  'settings.notifications.grantedUnsubscribed': '已授权，尚未订阅',
  'settings.notifications.denied': '已被浏览器设置阻止',
  'settings.notifications.enable': '启用通知',
  'settings.notifications.resubscribe': '重新订阅通知',
  'settings.notifications.deniedHelp': '请先在浏览器或系统设置中允许通知，然后回到这里。',
  'settings.notifications.unsupportedHelp': '请在 iOS Safari 或支持 Web Push 的浏览器中使用。',
```

- [ ] **Step 4: Implement Settings notifications section**

In `web/src/routes/settings/index.tsx`:

- Add imports:

```ts
import { useAppContext } from '@/lib/app-context'
import { usePushNotifications } from '@/hooks/usePushNotifications'
```

- Inside `SettingsPage()`, after `const { appearance, setAppearance } = useAppearance()`, add:

```ts
    const { api } = useAppContext()
    const {
        isSupported: isPushSupported,
        permission: pushPermission,
        isSubscribed: isPushSubscribed,
        requestPermission,
        subscribe,
        refreshSubscription
    } = usePushNotifications(api)
    const [isNotificationBusy, setIsNotificationBusy] = useState(false)
```

- Add helper state before `return (`:

```ts
    const notificationStatusLabel = (() => {
        if (!isPushSupported) return t('settings.notifications.unsupported')
        if (pushPermission === 'denied') return t('settings.notifications.denied')
        if (pushPermission === 'granted' && isPushSubscribed) return t('settings.notifications.grantedSubscribed')
        if (pushPermission === 'granted') return t('settings.notifications.grantedUnsubscribed')
        return t('settings.notifications.default')
    })()

    const notificationButtonLabel = pushPermission === 'granted'
        ? t('settings.notifications.resubscribe')
        : t('settings.notifications.enable')

    const canEnableNotifications = isPushSupported
        && pushPermission !== 'denied'
        && !(pushPermission === 'granted' && isPushSubscribed)

    const handleEnableNotifications = async () => {
        if (!canEnableNotifications || isNotificationBusy) return
        setIsNotificationBusy(true)
        try {
            const granted = pushPermission === 'granted' || await requestPermission()
            if (granted) {
                await subscribe()
            }
            await refreshSubscription()
        } finally {
            setIsNotificationBusy(false)
        }
    }
```

- Insert this section between Display and Voice Assistant sections:

```tsx
                    {/* Notifications section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.notifications.title')}
                        </div>
                        <div className="flex w-full items-center justify-between gap-3 px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.notifications.status')}</span>
                            <span className="text-right text-[var(--app-hint)]">{notificationStatusLabel}</span>
                        </div>
                        {pushPermission === 'denied' && (
                            <div className="px-3 pb-3 text-sm text-[var(--app-hint)]">
                                {t('settings.notifications.deniedHelp')}
                            </div>
                        )}
                        {!isPushSupported && (
                            <div className="px-3 pb-3 text-sm text-[var(--app-hint)]">
                                {t('settings.notifications.unsupportedHelp')}
                            </div>
                        )}
                        {canEnableNotifications && (
                            <div className="px-3 pb-3">
                                <button
                                    type="button"
                                    onClick={handleEnableNotifications}
                                    disabled={isNotificationBusy}
                                    className="rounded-lg bg-[var(--app-link)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                                >
                                    {notificationButtonLabel}
                                </button>
                            </div>
                        )}
                    </div>
```

- [ ] **Step 5: Run settings tests to verify GREEN**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun test web/src/routes/settings/index.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit settings UI changes**

Run:

```bash
git add web/src/routes/settings/index.tsx web/src/routes/settings/index.test.tsx web/src/lib/locales/en.ts web/src/lib/locales/zh-CN.ts
git commit -m "feat: add notification settings controls"
```

## Task 6: Service Worker Notification Click Focus

**Files:**
- Modify: `web/src/sw.ts`

- [ ] **Step 1: Update notification click handler**

Replace the existing `notificationclick` listener in `web/src/sw.ts` with:

```ts
self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'

    event.waitUntil((async () => {
        const windowClients = await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        })

        for (const client of windowClients) {
            if ('focus' in client) {
                if ('navigate' in client) {
                    await client.navigate(url)
                }
                return await client.focus()
            }
        }

        return await self.clients.openWindow(url)
    })())
})
```

- [ ] **Step 2: Run web build-focused typecheck**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run typecheck:web
```

Expected: PASS.

- [ ] **Step 3: Commit service worker change**

Run:

```bash
git add web/src/sw.ts
git commit -m "feat: focus session from push notification clicks"
```

## Task 7: Full Verification

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run hub tests**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run test:hub
```

Expected: PASS with 0 failing tests.

- [ ] **Step 2: Run web tests**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run test:web
```

Expected: PASS with 0 failing tests.

- [ ] **Step 3: Run hub typecheck**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run typecheck:hub
```

Expected: PASS.

- [ ] **Step 4: Run web typecheck**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run typecheck:web
```

Expected: PASS.

- [ ] **Step 5: Browser smoke test notification settings**

Run the app:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
bun run dev
```

Open HAPI Web, sign in, go to `/settings`, and verify:

- Notifications section appears.
- Permission `default` shows `Not enabled` and `Enable notifications`.
- Clicking `Enable notifications` prompts the browser permission dialog.
- Granting permission stores a push subscription in the hub database.
- Foreground attention events show SSE toast instead of system push.

- [ ] **Step 6: Review diff**

Run:

```bash
cd /Users/tehao/Documents/Playground/hapi-source
git diff --stat HEAD~6..HEAD
git log --oneline -6
```

Expected: six feature commits after this plan commit, with changes limited to hub notifications, push channel, web push hooks, settings UI, locales, and service worker.
