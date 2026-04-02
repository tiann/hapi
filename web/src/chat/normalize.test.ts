import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: null,
        content,
        createdAt: 1_742_372_800_000
    }
}

describe('normalizeDecryptedMessage', () => {
    it('maps Codex parentToolCallId to sidechainKey on sidechain agent payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'tool-call-1',
                    id: 'tool-use-1',
                    name: 'spawn',
                    input: { prompt: 'hi' },
                    isSidechain: true,
                    parentToolCallId: 'spawn-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: true,
            sidechainKey: 'spawn-1',
            content: [
                {
                    type: 'tool-call',
                    id: 'tool-call-1'
                }
            ]
        })
    })

    it('keeps normal Codex payloads root-level when parentToolCallId is absent', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'tool-call-1',
                    id: 'tool-use-1',
                    name: 'spawn',
                    input: { prompt: 'hi' }
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })
        expect(normalizeDecryptedMessage(message)?.sidechainKey).toBeUndefined()
    })

    it('keeps Codex payloads root-level when parentToolCallId is present without isSidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'tool-call-1',
                    id: 'tool-use-1',
                    name: 'spawn',
                    input: { prompt: 'hi' },
                    parentToolCallId: 'spawn-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })
        expect(normalizeDecryptedMessage(message)?.sidechainKey).toBeUndefined()
    })
    it('preserves user sidechain metadata from record meta', () => {
        const message = makeMessage({
            role: 'user',
            content: {
                type: 'text',
                text: 'child transcript prompt'
            },
            meta: {
                isSidechain: true,
                sidechainKey: 'spawn-1'
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'user',
            isSidechain: true,
            sidechainKey: 'spawn-1',
            content: {
                type: 'text',
                text: 'child transcript prompt'
            }
        })
    })

    it('drops unsupported Claude system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'stop_hook_summary',
                    uuid: 'sys-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('drops Claude init system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'init',
                    uuid: 'sys-init',
                    session_id: 'session-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps known Claude system subtypes as normalized events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    uuid: 'sys-2',
                    durationMs: 1200
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'turn-duration',
                durationMs: 1200
            }
        })
    })

    it('keeps the stringify fallback for unknown non-system agent payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    foo: 'bar'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })

        expect(normalized?.role).toBe('agent')
        if (!normalized || normalized.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        const firstBlock = normalized.content[0]
        expect(firstBlock).toMatchObject({
            type: 'text',
        })
        if (firstBlock.type !== 'text') {
            throw new Error('Expected fallback text block')
        }
        expect(firstBlock.text).toContain('"foo": "bar"')
    })

    it('converts <task-notification> user output to event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: { content: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: { type: 'message', message: 'Background command stopped' }
        })
    })

    it('treats <task-notification> without summary as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    message: { content: '<task-notification> <status>killed</status> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('treats non-sidechain string user output as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    uuid: 'u1',
                    message: { content: 'This is a subagent prompt' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is a subagent prompt'
        })
    })

    it('treats <system-reminder> user output as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u2',
                    message: { content: '<system-reminder>Some internal reminder</system-reminder>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })
})
