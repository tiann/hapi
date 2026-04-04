import { describe, expect, it, vi } from 'bun:test'
import type { Store, StoredSession } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

type EmittedEvent = {
    event: string
    data: unknown
}

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
    readonly emitted: EmittedEvent[] = []
    readonly roomEmits: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    constructor(id: string) {
        this.id = id
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(event: string, data: unknown): boolean {
        this.emitted.push({ event, data })
        return true
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEmits.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data?: unknown): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        if (typeof data === 'undefined') {
            handler()
            return
        }
        handler(data)
    }
}

describe('cli session handlers', () => {
    it('preserves nested subagent metadata when storing message content', () => {
        const addMessage = vi.fn((sessionId: string, content: unknown, localId?: string) => ({
            id: 'message-1',
            sessionId,
            content,
            createdAt: 123,
            seq: 1,
            localId: localId ?? null
        }))

        const store = {
            messages: {
                addMessage
            },
            sessions: {
                getSession: () => ({ namespace: 'default' } as StoredSession),
                setSessionTodos: () => false,
                setSessionTeamState: () => false
            }
        } as unknown as Store

        const socket = new FakeSocket('cli-socket')

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: { namespace: 'default' } as StoredSession }),
            emitAccessError: () => {}
        })

        const payload = {
            role: 'assistant',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'OtherTool',
                    input: { foo: 'bar' },
                    meta: {
                        subagent: {
                            kind: 'spawn',
                            sidechainKey: 'task-1',
                            prompt: 'Investigate flaky test'
                        }
                    }
                }
            }
        }

        socket.trigger('message', {
            sid: 'session-1',
            message: JSON.stringify(payload),
            localId: 'local-1'
        })

        expect(addMessage).toHaveBeenCalledTimes(1)
        expect(addMessage.mock.calls[0]).toEqual([
            'session-1',
            payload,
            'local-1'
        ])
    })
})
