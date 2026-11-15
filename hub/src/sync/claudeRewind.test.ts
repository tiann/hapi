import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

function agentText(text: string) {
    return {
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }
    }
}

function seedTwoTurns(store: Store, session: { id: string }) {
    store.messages.addMessage(session.id, { role: 'user', content: 'codename is ARLO-7' }, 'local-t1')
    store.messages.addMessage(session.id, agentText('OK, ARLO-7'))
    store.messages.markMessagesInvoked(session.id, ['local-t1'], Date.now())
    store.messages.addMessage(session.id, { role: 'user', content: 'favorite color is teal' }, 'local-t2')
    store.messages.addMessage(session.id, agentText('OK, teal'))
    store.messages.markMessagesInvoked(session.id, ['local-t2'], Date.now())
}

describe('Claude rewind hub integration', () => {
    it('truncates the hub at rewind-RPC success and keeps a prompt sent afterwards with its reply', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-newprompt', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: true,
                truncateFromLocalId: 'local-t2',
            })

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })

            // The hub truncation is immediate: the boundary turn and everything
            // after it are gone from the hub at RPC success, before any native
            // evidence exists. No later truncation pass can eat new conversation.
            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')

            // The user sends a new prompt right after the rewind; its reply streams in.
            const newPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'what was the last thing I asked you?' }, 'local-new')
            store.messages.markMessagesInvoked(session.id, ['local-new'], Date.now())
            const newReply = store.messages.addMessage(session.id, agentText('You asked me to remember your favorite color: teal'))

            const rows = store.messages.getAllMessages(session.id)
            const ids = new Set(rows.map((m) => m.id))
            expect(ids.has(newPrompt.id)).toBe(true)
            expect(ids.has(newReply.id)).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('refuses fork and rewind while a rewind intent is pending', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-pending', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true, forkCurrent: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)
            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            store.sessions.updateSessionMetadata(session.id, {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    targetLocalId: 'local-t2',
                    truncateFromLocalId: 'local-t2',
                    keepBoundary: 'native-boundary-uuid',
                    droppedPrompts: ['native-prompt-uuid'],
                },
            }, (stored?.metadataVersion ?? 1) as number, 'default')
            ;(engine as any).sessionCache.refreshSession(session.id)
            expect((engine.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeTruthy()

            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: true,
                truncateFromLocalId: 'local-t2',
            })
            ;(engine as any).rpcGateway.forkConversation = async () => ({ type: 'success', sessionId: 'child-x' })

            await expect(engine.rewindConversation(session.id, 'default', 'local-t1')).resolves.toMatchObject({
                type: 'error',
                message: 'A Claude rewind is pending; send a message to settle it first',
            })
            await expect(engine.forkConversation(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'A Claude rewind is pending; send a message to settle it first',
            })
        } finally {
            engine.stop()
        }
    })

    it('lifts the pending-rewind guard once the runner cleared the satisfied intent', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-clears', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true, forkCurrent: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)
            const writeIntent = () => {
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                }, (stored?.metadataVersion ?? 1) as number, 'default')
                ;(engine as any).sessionCache.refreshSession(session.id)
            }
            writeIntent()
            expect((engine.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeTruthy()

            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: true,
                truncateFromLocalId: 'local-t2',
            })
            ;(engine as any).rpcGateway.forkConversation = async () => ({ nativeSessionId: 'native-child-x' })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                const childId = args[12] as string
                engine.handleSessionAlive({ sid: childId, time: Date.now(), mode: 'remote' })
                engine.handleSessionReady({ sid: childId, time: Date.now() })
                const child = store.sessions.getSession(childId) as { metadataVersion?: number; metadata?: Record<string, unknown> } | undefined
                if (child) {
                    store.sessions.updateSessionMetadata(childId, { ...(child.metadata ?? {}), claudeSessionId: 'native-child-x' }, (child.metadataVersion ?? 1) as number, 'default')
                    ;(engine as any).sessionCache.refreshSession(childId)
                }
                return { type: 'success', sessionId: childId }
            }

            await expect(engine.forkConversation(session.id, 'default')).resolves.toMatchObject({
                type: 'error',
                message: 'A Claude rewind is pending; send a message to settle it first',
            })

            // Two runner paths clear the intent, and the guard is metadata
            // presence, so both lift it: the in-run native proof (the submitted
            // prompt re-parented onto the kept boundary) and the startup
            // reconcile (a stale or already-satisfied record - dropped turns
            // gone from the native chain - is cleared on every start instead
            // of blocking fork/rewind forever).
            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            const { claudeRewind: _cleared, ...rest } = (stored?.metadata ?? {}) as Record<string, unknown>
            store.sessions.updateSessionMetadata(session.id, rest, (stored?.metadataVersion ?? 1) as number, 'default')
            ;(engine as any).sessionCache.refreshSession(session.id)
            expect((engine.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeUndefined()

            await expect(engine.forkConversation(session.id, 'default')).resolves.toMatchObject({ type: 'success' })
            await expect(engine.rewindConversation(session.id, 'default', 'local-t1')).resolves.toMatchObject({ type: 'success' })
        } finally {
            engine.stop()
        }
    })

    it('truncates the hub when the rewind RPC is lost but the committed intent is visible', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-crash', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                // The runner persists the durable intent BEFORE it starts the
                // restart teardown; a crash in that window leaves the intent
                // visible hub-side while the RPC response is lost. Model the
                // flush landing mid-RPC.
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                }, (stored?.metadataVersion ?? 1) as number, 'default')
                ;(engine as any).sessionCache.refreshSession(session.id)
                throw new Error('rpc gateway timeout')
            }

            // The rewind is committed: the native branch re-arms from the
            // intent on the next start, so the hub must truncate now instead
            // of marking the transcript diverged.
            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })

            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')
            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).conversationHistoryDiverged).not.toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('still marks history diverged when the RPC fails without a committed intent', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-nocrash', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                throw new Error('rpc gateway timeout')
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toMatchObject({
                type: 'error',
                hydrateFailed: true,
                message: 'Rewind outcome is unknown; session history requires reconciliation'
            })
            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).conversationHistoryDiverged).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('scrubs an uncommitted rewind intent when the CLI rejects the rewind after a slow metadata write landed', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-rejected-flush', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                }, (stored?.metadataVersion ?? 1) as number, 'default')
                ;(engine as any).sessionCache.refreshSession(session.id)
                return {
                    success: false,
                    outcome: 'rejected',
                    error: 'Rewind intent could not be persisted'
                }
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({
                type: 'error',
                message: 'Rewind intent could not be persisted'
            })

            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).toContain('local-t2')
            expect((engine.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeUndefined()
            expect((store.sessions.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('reconciles a persisted claudeRewind intent idempotently on hub startup before RPC completion', async () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        let engine3: SyncEngine | null = null
        const rpcHolder: { release?: () => void } = {}

        try {
            const session = engine1.getOrCreateSession('claude-rewind-restart', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine1.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine1 as any).rpcGateway.rewindConversation = () => new Promise((resolve) => {
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                }, (stored?.metadataVersion ?? 1) as number, 'default')
                rpcHolder.release = () => resolve({ success: true, truncateFromLocalId: 'local-t2' })
            })

            const inflightRewind = engine1.rewindConversation(session.id, 'default', 'local-t2')
            await new Promise((resolve) => setTimeout(resolve, 10))
            // Intent landed in SQLite while RPC is still in flight and hub transcript is untouched.
            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).toContain('local-t2')
            engine1.stop()

            const restart2Broadcasts: Array<Record<string, unknown>> = []
            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), {
                broadcast(event: Record<string, unknown>) { restart2Broadcasts.push(event) }
            } as never)

            const keptAfterFirstRestart = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(keptAfterFirstRestart).toContain('local-t1')
            expect(keptAfterFirstRestart).not.toContain('local-t2')
            expect(restart2Broadcasts).toContainEqual(expect.objectContaining({
                type: 'messages-invalidated',
                sessionId: session.id,
                reason: 'rewind',
                truncateFromLocalId: 'local-t2',
            }))
            expect((engine2.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeDefined()
            expect((engine2.getSession(session.id)?.metadata as Record<string, unknown> | null)?.conversationHistoryDiverged).toBeUndefined()

            // Post-rewind conversation lands before the intent is later cleared.
            const newPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'after restart prompt' }, 'local-new')
            store.messages.markMessagesInvoked(session.id, ['local-new'], Date.now())
            const newReply = store.messages.addMessage(session.id, agentText('OK, post-restart reply'))

            engine2.stop()
            engine2 = null

            const restart3Broadcasts: Array<Record<string, unknown>> = []
            engine3 = new SyncEngine(store, {} as never, new RpcRegistry(), {
                broadcast(event: Record<string, unknown>) { restart3Broadcasts.push(event) }
            } as never)

            const rowsAfterSecondRestart = store.messages.getAllMessages(session.id)
            expect(rowsAfterSecondRestart.map((m) => m.localId)).toContain('local-t1')
            expect(rowsAfterSecondRestart.map((m) => m.id)).toContain(newPrompt.id)
            expect(rowsAfterSecondRestart.map((m) => m.id)).toContain(newReply.id)
            expect(restart3Broadcasts.some((event) => event.type === 'messages-invalidated')).toBe(false)

            rpcHolder.release?.()
            await inflightRewind
        } finally {
            rpcHolder.release?.()
            engine1.stop()
            engine2?.stop()
            engine3?.stop()
        }
    })

    it('marks history diverged on startup when a persisted claudeRewind is paired with uninvoked queued messages', () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null

        try {
            const session = engine1.getOrCreateSession('claude-rewind-restart-unsafe', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)
            store.messages.addMessage(session.id, { role: 'user', content: 'queued before restart' }, 'local-queued')

            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            store.sessions.updateSessionMetadata(session.id, {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    targetLocalId: 'local-t2',
                    truncateFromLocalId: 'local-t2',
                    keepBoundary: 'native-boundary-uuid',
                    droppedPrompts: ['native-prompt-uuid'],
                },
            }, (stored?.metadataVersion ?? 1) as number, 'default')
            engine1.stop()

            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

            expect(((engine2.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).conversationHistoryDiverged).toBe(true)
            const localIds = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(localIds).toContain('local-t1')
            expect(localIds).toContain('local-t2')
            expect(localIds).toContain('local-queued')
        } finally {
            engine1.stop()
            engine2?.stop()
        }
    })
})