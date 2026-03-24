import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { BarkNotificationChannel, createBarkNotificationChannel, type BarkNotificationSender } from './barkNotificationChannel'
import type { BarkAttentionPayload } from './barkDelivery'

class RecordingSender implements BarkNotificationSender {
    readonly payloads: BarkAttentionPayload[] = []

    async send(payload: BarkAttentionPayload): Promise<void> {
        this.payloads.push(payload)
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
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        ...overrides
    }
}

describe('createBarkNotificationChannel', () => {
    it('returns null when device key is missing', () => {
        const channel = createBarkNotificationChannel({
            deviceKey: null,
            serverUrl: 'https://api.day.app',
            publicUrl: 'https://app.example.com'
        })
        expect(channel).toBeNull()
    })

    it('returns channel when device key exists', () => {
        const channel = createBarkNotificationChannel({
            deviceKey: 'abc',
            serverUrl: 'https://api.day.app',
            publicUrl: 'https://app.example.com'
        })
        expect(channel).not.toBeNull()
    })
})

describe('BarkNotificationChannel', () => {
    it('maps permission payload fields with tool hint', async () => {
        const sender = new RecordingSender()
        const channel = new BarkNotificationChannel(sender, 'https://app.example.com')
        const session = createSession({
            id: 'sid-1',
            metadata: {
                path: '/tmp/demo-session',
                host: 'localhost',
                name: 'demo-session'
            },
            agentState: {
                requests: {
                    r1: {
                        tool: 'Edit',
                        arguments: {},
                        createdAt: 1
                    }
                }
            }
        })

        await channel.sendPermissionRequest(session)

        expect(sender.payloads).toHaveLength(1)
        expect(sender.payloads[0]).toEqual({
            title: 'Permission Request',
            body: 'demo-session (Edit)',
            group: 'permission-sid-1',
            url: 'https://app.example.com/sessions/sid-1'
        })
    })

    it('maps ready payload fields using session + agent naming helpers', async () => {
        const sender = new RecordingSender()
        const channel = new BarkNotificationChannel(sender, 'https://app.example.com')
        const session = createSession({
            id: 'sid-2',
            metadata: {
                host: 'localhost',
                path: '/tmp/project-a',
                flavor: 'codex'
            }
        })

        await channel.sendReady(session)

        expect(sender.payloads).toHaveLength(1)
        expect(sender.payloads[0]).toEqual({
            title: 'Ready for input',
            body: 'Codex is waiting in project-a',
            group: 'ready-sid-2',
            url: 'https://app.example.com/sessions/sid-2'
        })
    })

    it('preserves public URL path prefix in session links', async () => {
        const sender = new RecordingSender()
        const channel = new BarkNotificationChannel(sender, 'https://app.example.com/hapi')
        const session = createSession({ id: 'sid-3' })

        await channel.sendReady(session)

        expect(sender.payloads).toHaveLength(1)
        expect(sender.payloads[0]?.url).toBe('https://app.example.com/hapi/sessions/sid-3')
    })
})
