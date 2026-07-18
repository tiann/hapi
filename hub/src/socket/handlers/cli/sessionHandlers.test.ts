import { describe, expect, it } from 'bun:test'
import { registerSessionHandlers } from './sessionHandlers'
import type { CliSocketWithData } from '../../socketTypes'
import type { StoredSession } from '../../../store'

type RoomEmit = {
    room: string
    event: string
    data: unknown
}

type WebappEvent = {
    type: string
    sessionId?: string
    message?: {
        content: unknown
    }
}

class FakeSocket {
    readonly id = 'socket-1'
    readonly data: Record<string, unknown> = { namespace: 'default' }
    readonly roomEmits: RoomEmit[] = []
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()

    on(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    emit(): boolean {
        return true
    }

    to(room: string): { emit: (event: string, data: unknown) => boolean } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEmits.push({ room, event, data })
                return true
            }
        }
    }

    trigger(event: string, ...args: unknown[]): void {
        const handler = this.handlers.get(event)
        if (!handler) return
        handler(...args)
    }
}

type CreateHarnessOptions = {
    metadataUpdateResult?: 'success' | 'version-mismatch' | 'error'
    sessionMetadata?: Record<string, unknown>
    existingMessages?: Array<{
        sessionId?: string
        content: unknown
        localId?: string | null
        createdAt?: number
        seq?: number
    }>
}

function createHarness(options: CreateHarnessOptions = {}) {
    const { metadataUpdateResult = 'success', sessionMetadata, existingMessages = [] } = options
    const socket = new FakeSocket()
    const storedMessages: Array<{ sid: string; content: unknown; localId?: string }> = []
    const allMessages = existingMessages.map((message, index) => ({
        id: `existing-${index + 1}`,
        sessionId: message.sessionId ?? 'session-1',
        content: message.content,
        localId: message.localId ?? null,
        createdAt: message.createdAt ?? Date.now(),
        seq: message.seq ?? index + 1
    }))
    const webappEvents: WebappEvent[] = []
    const metadataUpdates: Array<{
        sid: string
        metadata: unknown
        expectedVersion: number
        namespace: string
        options?: { touchUpdatedAt?: boolean }
    }> = []
    const messageTouches: Array<{
        sid: string
        updatedAt: number
        messageSeq: number
        namespace: string
    }> = []
    const managedOutcomeRequests: unknown[] = []
    const deliveryAttemptRequests: unknown[] = []
    let seq = allMessages.reduce((max, message) => Math.max(max, message.seq), 0)
    const baseMetadata: Record<string, unknown> = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex'
    }
    const session = {
        namespace: 'default',
        metadataVersion: 3,
        metadata: { ...baseMetadata, ...(sessionMetadata ?? {}) },
        teamState: null,
        seq: 0,
        updatedAt: 1_710_000_000_000
    }
    const store = {
        managedSessions: {
            markOutcome(request: unknown) {
                managedOutcomeRequests.push(request)
                return { result: 'success' as const, canonicalSessionId: 'session-1', version: 4 }
            },
            resolveCanonical() { return 'session-1' }
        },
        deliveryAttempts: {
            append(request: unknown) {
                deliveryAttemptRequests.push(request)
                return { result: 'success' as const, state: 'written' as const }
            }
        },
        messages: {
            addMessage(sid: string, content: unknown, localId?: string) {
                seq += 1
                storedMessages.push({ sid, content, localId })
                const message = {
                    id: `message-${seq}`,
                    sessionId: sid,
                    seq,
                    createdAt: 1_710_000_000_000 + seq,
                    localId: localId ?? null,
                    content
                }
                allMessages.push(message)
                return message
            },
            getMessages(sessionId: string, limit = 200) {
                return allMessages
                    .filter((message) => message.sessionId === sessionId)
                    .sort((left, right) => left.seq - right.seq)
                    .slice(-limit)
            }
        },
        sessions: {
            getSession() {
                return session
            },
            getSessionByNamespace() {
                return { ...session, machineId: null, metadata: { ...session.metadata, machineId: 'machine-1', launchNonce: 'launch-1' } }
            },
            updateSessionMetadata(
                sid: string,
                metadata: unknown,
                expectedVersion: number,
                namespace: string,
                updateOptions?: { touchUpdatedAt?: boolean }
            ) {
                metadataUpdates.push({ sid, metadata, expectedVersion, namespace, options: updateOptions })
                if (metadataUpdateResult === 'version-mismatch') {
                    return {
                        result: 'version-mismatch' as const,
                        version: session.metadataVersion + 1,
                        value: session.metadata
                    }
                }
                if (metadataUpdateResult === 'error') {
                    return { result: 'error' as const }
                }
                session.metadata = metadata as typeof session.metadata
                session.metadataVersion += 1
                return {
                    result: 'success',
                    version: session.metadataVersion,
                    value: metadata
                }
            },
            touchSessionMessage(sid: string, updatedAt: number, messageSeq: number, namespace: string) {
                messageTouches.push({ sid, updatedAt, messageSeq, namespace })
                if (session.updatedAt >= updatedAt && session.seq >= messageSeq) {
                    return false
                }
                session.updatedAt = Math.max(session.updatedAt, updatedAt)
                session.seq = Math.max(session.seq, messageSeq)
                return true
            },
            setSessionTodos() {
                return null
            },
            setSessionTeamState() {
                return null
            }
        }
    }

    registerSessionHandlers(socket as unknown as CliSocketWithData, {
        store: store as never,
        resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
        emitAccessError: () => {
            throw new Error('Unexpected access error')
        },
        onWebappEvent: (event) => {
            webappEvents.push(event as WebappEvent)
        }
    })

    return { socket, storedMessages, webappEvents, metadataUpdates, messageTouches, managedOutcomeRequests, deliveryAttemptRequests, session, allMessages }
}

describe('cli session handlers', () => {
    it('routes namespace-bound managed outcomes and acknowledges the canonical session', () => {
        const { socket, managedOutcomeRequests, webappEvents } = createHarness()
        let ack: unknown = null
        const request = {
            idempotencyKey: 'outcome-1', namespace: 'default', machineId: 'machine-1', sessionId: 'session-1',
            launchNonce: 'launch-1', runnerInstanceId: 'runner-1', expectedVersion: 3,
            lifecycleState: 'stopped', active: false, lifecycleStateSince: Date.now()
        }
        socket.trigger('mark-managed-session-outcome', request, (value: unknown) => { ack = value })
        expect(managedOutcomeRequests).toEqual([request])
        expect(ack).toEqual({ result: 'success', canonicalSessionId: 'session-1', version: 4 })
        expect(webappEvents).toEqual([{ type: 'session-updated', sessionId: 'session-1' }])
    })

    it('rejects managed outcomes for a different namespace', () => {
        const { socket, managedOutcomeRequests } = createHarness()
        let ack: unknown = null
        socket.trigger('mark-managed-session-outcome', {
            idempotencyKey: 'outcome-1', namespace: 'other', machineId: 'machine-1', sessionId: 'session-1',
            launchNonce: 'launch-1', runnerInstanceId: 'runner-1', expectedVersion: 3,
            lifecycleState: 'stopped', active: false, lifecycleStateSince: Date.now()
        }, (value: unknown) => { ack = value })
        expect(managedOutcomeRequests).toHaveLength(0)
        expect(ack).toEqual({ result: 'error', reason: 'access-denied' })
    })

    it('records launch-bound delivery attempt transitions', () => {
        const { socket, deliveryAttemptRequests } = createHarness()
        let ack: unknown = null
        socket.trigger('record-delivery-attempt', {
            idempotencyKey: 'delivery-1', namespace: 'default', machineId: 'machine-1', sessionId: 'session-1',
            messageId: 'message-1', sequence: 1, attemptId: 'attempt-1', launchNonce: 'launch-1',
            state: 'written', createdAt: 123
        }, (value: unknown) => { ack = value })
        expect(deliveryAttemptRequests).toEqual([expect.objectContaining({ canonicalSessionId: 'session-1', state: 'written' })])
        expect(ack).toEqual({ result: 'success', canonicalSessionId: 'session-1', state: 'written' })
    })

    it('rejects malformed managed outcome and delivery payloads without touching stores', () => {
        const { socket, managedOutcomeRequests, deliveryAttemptRequests } = createHarness()
        let outcomeAck: unknown = null
        let deliveryAck: unknown = null

        socket.trigger('mark-managed-session-outcome', {
            namespace: 'default', sessionId: {}, lifecycleState: 'bogus'
        }, (value: unknown) => { outcomeAck = value })
        socket.trigger('record-delivery-attempt', {
            namespace: 'default', sessionId: {}, launchNonce: undefined
        }, (value: unknown) => { deliveryAck = value })

        expect(managedOutcomeRequests).toHaveLength(0)
        expect(deliveryAttemptRequests).toHaveLength(0)
        expect(outcomeAck).toEqual({ result: 'error', reason: 'invalid-request' })
        expect(deliveryAck).toEqual({ result: 'error', reason: 'invalid-request' })
    })

    it('broadcasts normal remote-control messages to other CLI sockets', () => {
        const { socket, storedMessages, webappEvents, messageTouches } = createHarness()

        socket.trigger('message', {
            sid: 'session-1',
            localId: 'web-1',
            message: {
                role: 'user',
                content: { type: 'text', text: 'run this remotely' }
            }
        })

        expect(storedMessages).toHaveLength(1)
        expect(messageTouches).toEqual([{
            sid: 'session-1',
            updatedAt: 1_710_000_000_001,
            messageSeq: 1,
            namespace: 'default'
        }])
        expect(socket.roomEmits).toHaveLength(1)
        expect(socket.roomEmits[0]?.room).toBe('session:session-1')
        expect(socket.roomEmits[0]?.event).toBe('update')
        expect(webappEvents).toHaveLength(2)
        expect(webappEvents[0]?.type).toBe('session-updated')
        expect(webappEvents[1]?.type).toBe('message-received')
    })

    it('stores passive sync messages for web without broadcasting them to CLI executors', () => {
        const { socket, storedMessages, webappEvents, metadataUpdates, messageTouches } = createHarness()
        let ack: unknown = null

        socket.trigger('sync-message', {
            sid: 'session-1',
            localId: 'codex:thread-1:12:abc123',
            message: {
                role: 'user',
                content: { type: 'text', text: 'message typed in Codex desktop' }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(storedMessages).toHaveLength(1)
        expect(messageTouches).toEqual([{
            sid: 'session-1',
            updatedAt: 1_710_000_000_001,
            messageSeq: 1,
            namespace: 'default'
        }])
        expect(ack).toEqual({ inserted: true })
        expect(storedMessages[0]?.content).toEqual({
            role: 'user',
            content: { type: 'text', text: 'message typed in Codex desktop' },
            meta: { sentFrom: 'codex-desktop-sync' }
        })
        expect(socket.roomEmits).toHaveLength(1)
        expect(socket.roomEmits[0]?.room).toBe('session:session-1')
        expect(socket.roomEmits[0]?.event).toBe('update')
        expect(webappEvents).toHaveLength(3)
        expect(webappEvents[0]?.type).toBe('session-updated')
        expect(webappEvents[0]?.sessionId).toBe('session-1')
        expect(webappEvents[1]?.type).toBe('session-updated')
        expect(webappEvents[1]?.sessionId).toBe('session-1')
        expect(webappEvents[2]?.type).toBe('message-received')
        expect(webappEvents[2]?.sessionId).toBe('session-1')
        expect(metadataUpdates).toHaveLength(1)
        expect(metadataUpdates[0]).toMatchObject({
            sid: 'session-1',
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 1,
                    leaseExpiresAt: null,
                    runnerSessionId: null
                }
            },
            expectedVersion: 3,
            namespace: 'default',
            options: { touchUpdatedAt: false }
        })
        expect(typeof (metadataUpdates[0]?.metadata as { executionControl?: { updatedAt?: unknown } }).executionControl?.updatedAt).toBe('number')
    })

    it('does not stamp native HAPI runner sessions as desktop mirrors during passive transcript sync', () => {
        const { socket, storedMessages, webappEvents, metadataUpdates, messageTouches } = createHarness({
            sessionMetadata: {
                startedFromRunner: true,
                startedBy: 'runner'
            }
        })
        let ack: unknown = null

        socket.trigger('sync-message', {
            sid: 'session-1',
            source: 'codex-desktop-sync',
            generation: 1,
            localId: 'codex:thread-1:13:hapi-runner-echo',
            message: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'echo from the Codex transcript' } }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(ack).toEqual({ inserted: true })
        expect(storedMessages).toHaveLength(1)
        expect(messageTouches).toEqual([{
            sid: 'session-1',
            updatedAt: 1_710_000_000_001,
            messageSeq: 1,
            namespace: 'default'
        }])
        expect(metadataUpdates).toHaveLength(0)
        expect(webappEvents).toEqual([
            expect.objectContaining({
                type: 'session-updated',
                sessionId: 'session-1'
            }),
            expect.objectContaining({
                type: 'message-received',
                sessionId: 'session-1'
            })
        ])
    })

    it('skips passive desktop assistant replays when an equivalent HAPI runner message already exists', () => {
        const { socket, storedMessages, webappEvents, metadataUpdates, messageTouches } = createHarness({
            sessionMetadata: {
                startedFromRunner: true,
                startedBy: 'runner'
            },
            existingMessages: [{
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: 'same assistant reply from HAPI runner'
                        }
                    },
                    meta: { sentFrom: 'cli' }
                },
                createdAt: Date.now() - 500,
                seq: 1
            }]
        })
        let ack: unknown = null

        socket.trigger('sync-message', {
            sid: 'session-1',
            source: 'codex-desktop-sync',
            generation: 1,
            localId: 'codex:thread-1:14:duplicate-replay',
            message: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'same assistant reply from HAPI runner',
                        phase: 'final_answer'
                    }
                }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(ack).toEqual({ inserted: false, reason: 'duplicate' })
        expect(storedMessages).toHaveLength(0)
        expect(messageTouches).toHaveLength(0)
        expect(metadataUpdates).toHaveLength(0)
        expect(socket.roomEmits).toHaveLength(0)
        expect(webappEvents).toHaveLength(0)
    })

    it('skips passive desktop assistant replays that only append a memory citation block', () => {
        const hapiRunnerText = [
            '已开始按 `superpowers:brainstorming` 做设计，不写代码、不改 live 配置。',
            '',
            '推荐选：**是**。这样最利于版本隔离、回滚和未来 OpenClaw 升级稳定。'
        ].join('\n')
        const desktopReplayText = `${hapiRunnerText}\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:937-943|note=[OpenClaw voice provider history]\n</citation_entries>\n<rollout_ids>\n019d9fe2-c00a-7dd0-8681-8dd3583d2071\n</rollout_ids>\n</oai-mem-citation>`
        const { socket, storedMessages, webappEvents, metadataUpdates, messageTouches } = createHarness({
            sessionMetadata: {
                startedFromRunner: true,
                startedBy: 'runner'
            },
            existingMessages: [{
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: hapiRunnerText
                        }
                    },
                    meta: { sentFrom: 'cli' }
                },
                createdAt: Date.now() - 500,
                seq: 1
            }]
        })
        let ack: unknown = null

        socket.trigger('sync-message', {
            sid: 'session-1',
            source: 'codex-desktop-sync',
            generation: 1,
            localId: 'codex:thread-1:15:memory-citation-replay',
            message: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: desktopReplayText,
                        phase: 'final_answer'
                    }
                }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(ack).toEqual({ inserted: false, reason: 'duplicate' })
        expect(storedMessages).toHaveLength(0)
        expect(messageTouches).toHaveLength(0)
        expect(metadataUpdates).toHaveLength(0)
        expect(socket.roomEmits).toHaveLength(0)
        expect(webappEvents).toHaveLength(0)
    })

    it('rejects passive sync writes with stale generation before storing or broadcasting', () => {
        const { socket, storedMessages, webappEvents, metadataUpdates } = createHarness({
            sessionMetadata: {
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'desktop-sync',
                    generation: 2,
                    leaseExpiresAt: null,
                    runnerSessionId: null,
                    updatedAt: Date.now()
                }
            }
        })
        let ack: unknown = null

        socket.trigger('sync-message', {
            sid: 'session-1',
            source: 'codex-desktop-sync',
            generation: 1,
            localId: 'codex:thread-1:77:stale-generation',
            message: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'stale generation replay' } }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(ack).toEqual({ inserted: false, reason: 'stale-generation' })
        expect(storedMessages).toHaveLength(0)
        expect(metadataUpdates).toHaveLength(0)
        expect(socket.roomEmits).toHaveLength(0)
        expect(webappEvents).toHaveLength(0)
    })

    for (const metadataUpdateResult of ['version-mismatch', 'error'] as const) {
        it(`rejects passive sync writes when metadata update returns ${metadataUpdateResult}`, () => {
            const { socket, storedMessages, webappEvents, metadataUpdates } = createHarness({ metadataUpdateResult })
            let ack: unknown = null

            socket.trigger('sync-message', {
                sid: 'session-1',
                source: 'codex-desktop-sync',
                generation: 1,
                localId: `codex:thread-1:88:${metadataUpdateResult}`,
                message: {
                    role: 'user',
                    content: { type: 'text', text: `metadata ${metadataUpdateResult}` }
                }
            }, (value: unknown) => {
                ack = value
            })

            expect(ack).toEqual({ inserted: false, reason: 'metadata-conflict' })
            expect(storedMessages).toHaveLength(0)
            expect(metadataUpdates).toHaveLength(1)
            expect(socket.roomEmits).toHaveLength(0)
            expect(webappEvents).toHaveLength(0)
        })
    }

    it('preserves desktop takeover metadata when CLI sends a partial metadata snapshot', () => {
        const updatedAt = Date.now()
        const { socket, metadataUpdates, session } = createHarness({
            sessionMetadata: {
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 8,
                    leaseExpiresAt: updatedAt + 60_000,
                    runnerSessionId: 'runner-session',
                    updatedAt
                }
            }
        })
        let ack: unknown = null

        socket.trigger('update-metadata', {
            sid: 'session-1',
            expectedVersion: 3,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                summary: {
                    text: 'runner metadata update',
                    updatedAt: updatedAt + 1
                }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(metadataUpdates).toHaveLength(1)
        expect(metadataUpdates[0]).toMatchObject({
            sid: 'session-1',
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                mirrorSource: 'codex-desktop-sync',
                executionControl: {
                    owner: 'hapi-runner',
                    generation: 8,
                    runnerSessionId: 'runner-session'
                },
                summary: {
                    text: 'runner metadata update',
                    updatedAt: updatedAt + 1
                }
            },
            options: { touchUpdatedAt: false }
        })
        expect(ack).toMatchObject({
            result: 'success',
            metadata: metadataUpdates[0]?.metadata
        })
        expect(session.metadata).toMatchObject({
            mirrorSource: 'codex-desktop-sync',
            executionControl: {
                owner: 'hapi-runner',
                generation: 8,
                runnerSessionId: 'runner-session'
            }
        })
    })

    it('stores passive sync writes during hapi-runner ownership when generation matches', () => {
        const { socket, storedMessages, metadataUpdates, webappEvents, session, messageTouches } = createHarness()
        let ack: unknown = null

        session.metadata = {
            ...session.metadata,
            mirrorSource: 'codex-desktop-sync',
            executionControl: {
                owner: 'hapi-runner',
                generation: 1,
                leaseExpiresAt: Date.now() + 60_000,
                runnerSessionId: 'session-runner',
                updatedAt: Date.now()
            }
        }

        metadataUpdates.length = 0
        socket.trigger('sync-message', {
            sid: 'session-1',
            source: 'codex-desktop-sync',
            generation: 1,
            localId: 'codex:thread-1:99:stale',
            message: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: 'stale mirror replay' } }
            }
        }, (value: unknown) => {
            ack = value
        })

        expect(ack).toEqual({ inserted: true })
        expect(storedMessages).toHaveLength(1)
        expect(messageTouches).toEqual([{
            sid: 'session-1',
            updatedAt: 1_710_000_000_001,
            messageSeq: 1,
            namespace: 'default'
        }])
        expect(metadataUpdates).toHaveLength(0)
        expect(webappEvents).toEqual([
            expect.objectContaining({
                type: 'session-updated',
                sessionId: 'session-1'
            }),
            expect.objectContaining({
                type: 'message-received',
                sessionId: 'session-1'
            })
        ])
    })
})
