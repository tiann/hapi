import { describe, expect, it, mock } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { Store } from '../store'
import { FcmNotificationChannel } from '../fcm/fcmNotificationChannel'
import { AndroidRelayService } from '../fcm/androidRelayService'
import { IosPushNotificationChannel } from '../push-ios/iosPushChannel'
import { IosPushService } from '../push-ios/iosPushService'
import { decryptEnvelope } from '../push-native/envelope'
import type { EncryptedPushRequest } from '../push-native/transport'
import { PushNotificationChannel } from '../push/pushNotificationChannel'
import type { PushPayload } from '../push/pushService'
import { ServerChanChannel } from '../serverchan/channel'
import { createNotificationKeyboard, formatSessionNotification } from '../telegram/sessionView'
import { composeInputRequestNotification } from './inputRequest'

const session: Session = {
    id: 'session-input', namespace: 'default', active: true,
    seq: 1, createdAt: 0, updatedAt: 0, activeAt: 0,
    metadataVersion: 0, agentStateVersion: 0, thinking: false, thinkingAt: 0,
    model: null, modelReasoningEffort: null, effort: null, serviceTier: null,
    metadata: { flavor: 'codex', name: '查看 PR #1842 的改动', path: '/project', host: 'test' },
    agentState: { requests: {
        'request-input': { tool: 'request_user_input', toolCallId: 'not-the-request-id', arguments: {
            threadId: 'private-thread', questions: [{ id: 'scope', question: '需要检查安全性吗？' },
                { id: 'tests', question: '需要补测试吗？' }]
        } },
        'request-approval': { tool: 'Bash', arguments: { command: 'echo second' } }
    } }
}
const expected = composeInputRequestNotification(session)!

describe('input-request notification channels', () => {
    it.each(['ios', 'android'] as const)('preserves the summary, type and routing through encrypted %s delivery', async (platform) => {
        const store = new Store(':memory:')
        try {
            const key = Buffer.alloc(32, 1)
            store.fcm.upsertDevice(session.namespace, { token: 'device-token', deviceId: 'device-1',
                platform: platform === 'ios' ? 'ios' : 'phone', pushKey: key.toString('base64') })
            const requests: EncryptedPushRequest[] = []
            const transport = { async send(request: EncryptedPushRequest) {
                requests.push(request)
                return 'sent' as const
            } }
            const channel = platform === 'ios'
                ? new IosPushNotificationChannel(new IosPushService(transport, store))
                : new FcmNotificationChannel(new AndroidRelayService(transport, store),
                    { sendToast: async () => 1 } as never, { hasVisibleConnection: () => true } as never)
            const ctx = { nativeGate: { sent: false } }
            await channel.sendPermissionRequest(session, ctx)
            expect(ctx.nativeGate.sent).toBe(true)
            expect(requests).toHaveLength(1)
            const { tag: _tag, ...data } = expected
            expect(JSON.parse(decryptEnvelope(key, requests[0].envelope))).toEqual({ ...data, contractVersion: '1' })
            expect(requests[0].priority).toBe(10)
            expect(requests[0].collapseId).toBe(platform === 'ios' ? 'input-request-session-input' : undefined)
        } finally {
            store.close()
        }
    })

    it.each([
        { visible: false, toastCount: 0, nativeSent: false, delivery: 'push' },
        { visible: true, toastCount: 1, nativeSent: false, delivery: 'toast' },
        { visible: true, toastCount: 0, nativeSent: false, delivery: 'push' },
        { visible: true, toastCount: 1, nativeSent: true, delivery: 'native' }
    ])('keeps Web fallback and toast routing for $delivery (visible=$visible, count=$toastCount)', async ({ visible, toastCount, nativeSent, delivery }) => {
        const pushed: PushPayload[] = []
        const toasts: Array<{ data: { title: string; body: string; sessionId: string; url: string } }> = []
        const channel = new PushNotificationChannel({ sendToNamespace: async (namespace: string, payload: PushPayload) => {
            expect(namespace).toBe(session.namespace)
            pushed.push(payload)
        } } as never, { sendToast: async (_namespace: string, event: typeof toasts[number]) => {
            toasts.push(event)
            return toastCount
        } } as never, { hasVisibleConnection: () => visible } as never, '')
        await channel.sendPermissionRequest(session, { nativeGate: { sent: nativeSent } })
        expect(pushed).toHaveLength(delivery === 'push' ? 1 : 0)
        expect(toasts).toHaveLength(visible && !nativeSent ? 1 : 0)
        if (pushed[0]) expect(pushed[0]).toEqual({ title: expected.title, body: expected.body, tag: expected.tag,
            data: { type: 'input-request', sessionId: session.id, requestId: 'request-input', url: expected.url } })
        if (toasts[0]) expect(toasts[0].data).toEqual({ title: expected.title, body: expected.body,
            sessionId: session.id, url: expected.url })
    })

    it('gives Telegram the same summary with only an Open Session button', () => {
        expect(formatSessionNotification(session)).toBe(`${expected.title}\n\n${expected.body}`)
        expect(createNotificationKeyboard(session, 'https://hapi.example.com').inline_keyboard).toEqual([
            [{ text: 'Open Session', web_app: { url: 'https://hapi.example.com/?startapp=session_session-input' } }]
        ])
        const approvalFirst = { ...session, agentState: { requests: {
            'request-approval': session.agentState!.requests!['request-approval'],
            'request-input': session.agentState!.requests!['request-input']
        } } }
        const buttons = createNotificationKeyboard(approvalFirst, 'https://hapi.example.com').inline_keyboard.flat()
        expect(buttons.map(button => button.text)).toEqual(['Allow', 'Deny', 'Details'])
        expect(formatSessionNotification(approvalFirst)).toContain('Tool: Bash')
        expect(formatSessionNotification(approvalFirst)).not.toContain('needs your input')
    })

    it('gives Server酱 the same summary followed by the session link', async () => {
        const originalFetch = globalThis.fetch
        const fetchMock = mock(async (_url: string, init?: RequestInit) => {
            const fields = init?.body as URLSearchParams
            expect(fields.get('title')).toBe(`HAPI ${expected.title}`)
            expect(fields.get('desp')).toBe(`${expected.body}\n\nhttps://hapi.example.com${expected.url}`)
            return new Response('ok')
        })
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            await new ServerChanChannel('SCT_TEST', 'https://hapi.example.com').sendPermissionRequest(session)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
