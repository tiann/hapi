import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { FcmNotificationChannel } from './fcmNotificationChannel'
import type { FcmSendPayload } from './fcmService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-ready',
        namespace: 'default',
        name: 'Demo',
        active: true,
        metadata: { flavor: 'codex', name: 'Demo' },
        ...overrides
    } as Session
}

describe('FcmNotificationChannel', () => {
    it('always fires FCM regardless of PWA visibility (wrist-first)', async () => {
        const sent: FcmSendPayload[] = []
        const toasts: unknown[] = []
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 1
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never
        )

        await channel.sendReady(createSession())

        // The watch is the canonical surface when a native companion is
        // registered. The previous behaviour silently swallowed FCM when
        // the PWA was foreground - that broke the wrist-first UX. We now
        // fire FCM unconditionally and let the PWA's own SyncEngine event
        // stream handle in-page toasts (or not, per UX preference).
        expect(sent).toHaveLength(1)
        expect(toasts).toHaveLength(0)
    })

    it('includes requestId on permission-request payloads', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never
        )

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: {
                    'req-42': { tool: 'Bash', arguments: {} }
                }
            }
        }))

        expect(sent).toHaveLength(1)
        expect(sent[0].data.type).toBe('permission-request')
        expect(sent[0].data.requestId).toBe('req-42')
        expect(sent[0].data.contractVersion).toBe('1')
    })

    it('enriches permission-request body with tool args (Edit)', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never
        )

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: {
                    'req-99': {
                        tool: 'Edit',
                        arguments: {
                            file_path: '/home/u/proj/hub/src/server.ts',
                            old_string: 'foo',
                            new_string: 'bar'
                        }
                    }
                }
            }
        }))

        expect(sent).toHaveLength(1)
        const body = sent[0].body ?? ''
        const dataBody = sent[0].data.body ?? ''
        // Glance line: agent + tool + compact arg (last two path segments).
        expect(body).toContain('Edit')
        expect(body).toContain('hub/src/server.ts')
        // Detail: full file path on its own line, plus old/new previews -
        // visible when the watch operator taps to expand.
        expect(body).toContain('File: /home/u/proj/hub/src/server.ts')
        expect(body).toContain('Old: "foo"')
        expect(body).toContain('New: "bar"')
        // data.body must mirror notification body so the watch sees the same
        // text the FCM `notification` field would.
        expect(dataBody).toBe(body)
    })

    it('falls back gracefully when no tool args are present', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never
        )

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: {
                    'req-1': { tool: 'NewExperimentalTool', arguments: { foo: 'bar' } }
                }
            }
        }))

        const body = sent[0].body ?? ''
        // Compact returns '' for tools not in its switch table, so the glance
        // line collapses to bare "<agent> <tool>" - confirming we never emit
        // "<agent> <tool>: " with a dangling colon.
        expect(body.split('\n')[0]).toMatch(/NewExperimentalTool$/)
        expect(body).not.toContain(': \n')
    })

    function makeStoreWithMessages(messages: Array<{ content: unknown }>) {
        // Minimal store stub: only the bits FcmNotificationChannel touches.
        // Mirrors the real `getMessages` contract: callers receive the last N
        // rows in ASCENDING seq order (oldest first, latest last).
        return {
            messages: {
                getMessages: (_sessionId: string, _limit: number) => messages.map((m, i) => ({
                    id: `m-${i}`,
                    sessionId: 'session-ready',
                    content: m.content,
                    createdAt: i,
                    seq: i + 1,
                    localId: null,
                    invokedAt: null,
                    scheduledAt: null
                }))
            }
        } as never
    }

    it('sendReady prefers AGENT_NOTIFY_SUMMARY when last assistant message has one', async () => {
        const sent: FcmSendPayload[] = []
        const store = makeStoreWithMessages([
            // DESC order: index 0 = latest. Latest assistant text contains a summary.
            {
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: 'Did the work.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"summary":"Tokens revoked","action":"Upload preview","status":"done"}'
                        }
                    }
                }
            }
        ])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        expect(sent).toHaveLength(1)
        const p = sent[0]
        expect(p.title).toBe('Codex - Demo')
        expect(p.body).toBe('Tokens revoked\n-> Upload preview')
        expect(p.data.notifySummary).toBeDefined()
        const parsed = JSON.parse(p.data.notifySummary as string)
        expect(parsed.summary).toBe('Tokens revoked')
        expect(parsed.action).toBe('Upload preview')
    })

    it('sendReady caps long AGENT_NOTIFY_SUMMARY text for FCM data limits', async () => {
        const sent: FcmSendPayload[] = []
        const longSummary = 'S'.repeat(400)
        const longAction = 'A'.repeat(400)
        const store = makeStoreWithMessages([
            {
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: `Done.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"summary":"${longSummary}","action":"${longAction}","status":"done"}`
                        }
                    }
                }
            }
        ])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        expect(sent).toHaveLength(1)
        expect(sent[0].body.length).toBeLessThanOrEqual(280)
        const parsed = JSON.parse(sent[0].data.notifySummary as string)
        expect(parsed.summary.length).toBeLessThanOrEqual(280)
        expect(parsed.action.length).toBeLessThanOrEqual(280)
    })

    it('sendReady truncates last assistant text when no summary is present', async () => {
        const sent: FcmSendPayload[] = []
        const longText = 'A'.repeat(500)
        const store = makeStoreWithMessages([
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: longText } }
                }
            }
        ])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        const body = sent[0].body
        expect(body.length).toBeLessThanOrEqual(280)
        expect(body.endsWith('...')).toBe(true)
        expect(sent[0].data.notifySummary).toBeUndefined()
    })

    it('sendReady skips tool-call messages and uses the last assistant TEXT message', async () => {
        const sent: FcmSendPayload[] = []
        // Real getMessages returns ASC (oldest first, newest last). The newest
        // here is a tool-call-result; the channel must walk back past two
        // tool-call frames to find the actual assistant text.
        const store = makeStoreWithMessages([
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: 'The actual reply.' } }
                }
            },
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', callId: 'x', input: {} } }
                }
            },
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'tool-call-result', output: {} } }
                }
            }
        ])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        expect(sent[0].body).toBe('The actual reply.')
    })

    it('sendReady picks the LATEST assistant text when multiple text messages exist (ASC ordering regression guard)', async () => {
        const sent: FcmSendPayload[] = []
        // Two text messages, oldest first - the channel must return the
        // last one ("Latest reply.") not the first ("Older reply.").
        // This guards against a real bug where we walked the array
        // assuming DESC ordering and picked the oldest.
        const store = makeStoreWithMessages([
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: 'Older reply.' } }
                }
            },
            {
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: 'Latest reply.' } }
                }
            }
        ])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        expect(sent[0].body).toBe('Latest reply.')
    })

    it('sendReady falls back to "is waiting" line when no agent text exists', async () => {
        const sent: FcmSendPayload[] = []
        const store = makeStoreWithMessages([])
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            store
        )

        await channel.sendReady(createSession())

        expect(sent[0].title).toBe('Ready for input')
        expect(sent[0].body).toBe('Codex is waiting in Demo')
    })

    it('sendReady falls back when the channel has no store (test/legacy wiring)', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: FcmSendPayload) => {
                    sent.push(payload)
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
            // store omitted on purpose
        )

        await channel.sendReady(createSession())

        expect(sent[0].title).toBe('Ready for input')
        expect(sent[0].body).toBe('Codex is waiting in Demo')
    })

    it('sets severity=info on ready notifications', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            { sendToNamespace: async (_n: string, p: FcmSendPayload) => { sent.push(p) } } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )
        await channel.sendReady(createSession())
        expect(sent[0].data.severity).toBe('info')
    })

    it('sets nativeGate.sent when FCM delivers at least one message', async () => {
        const gate = { sent: false }
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async () => ({ sent: 1, failed: 0, invalidTokens: [] })
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )

        await channel.sendReady(createSession(), { nativeGate: gate })

        expect(gate.sent).toBe(true)
    })

    it('leaves nativeGate.sent false when FCM sends zero messages', async () => {
        const gate = { sent: false }
        const channel = new FcmNotificationChannel(
            {
                sendToNamespace: async () => ({ sent: 0, failed: 1, invalidTokens: [] })
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )

        await channel.sendReady(createSession(), { nativeGate: gate })

        expect(gate.sent).toBe(false)
    })

    it('sets severity=warning on permission-request notifications', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            { sendToNamespace: async (_n: string, p: FcmSendPayload) => { sent.push(p) } } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )
        await channel.sendPermissionRequest(createSession({
            agentState: { requests: { 'r-1': { tool: 'Bash', arguments: {} } } }
        }))
        expect(sent[0].data.severity).toBe('warning')
    })

    it('sets severity=success on completed task notifications', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            { sendToNamespace: async (_n: string, p: FcmSendPayload) => { sent.push(p) } } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )
        await channel.sendTaskNotification(createSession(), { status: 'completed', summary: 'Tests passed' })
        expect(sent[0].data.severity).toBe('success')
    })

    it('sets severity=error on failed task notifications', async () => {
        const sent: FcmSendPayload[] = []
        const channel = new FcmNotificationChannel(
            { sendToNamespace: async (_n: string, p: FcmSendPayload) => { sent.push(p) } } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never
        )
        // The hub's failure detection catches 'failed' / 'error' / 'killed' / 'aborted'.
        for (const status of ['failed', 'error', 'killed', 'aborted']) {
            sent.length = 0
            await channel.sendTaskNotification(createSession(), { status, summary: 'oh no' })
            expect(sent[0].data.severity).toBe('error')
        }
    })
})
