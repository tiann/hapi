import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { CliSocketWithData } from '../socket/socketTypes'
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

    it('broadcasts the hub cut confirmation to CLI sockets after a successful marker write', async () => {
        const store = new Store(':memory:')
        const cliUpdates: Array<{ room: string; event: string; update: any }> = []
        const io = {
            of: () => ({
                to: (room: string) => ({
                    emit: (event: string, update: any) => cliUpdates.push({ room, event, update })
                })
            })
        }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('claude-rewind-cut-broadcast', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                // The runner persists the durable intent before the restart
                // teardown; the flush that gates the RPC reply is what makes
                // it visible here.
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
                return { success: true, truncateFromLocalId: 'local-t2' }
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })

            // A CLI that already holds native proof must see the marker without
            // waiting for its next write or a reconnect; otherwise fork/rewind
            // stays blocked until then.
            const markerUpdate = cliUpdates.find(
                (entry) => entry.room === `session:${session.id}` && entry.event === 'update'
            )
            expect(markerUpdate).toBeDefined()
            expect(markerUpdate!.update.body.sid).toBe(session.id)
            expect(markerUpdate!.update.body.metadata.value.claudeRewind.hubCutApplied).toBe(true)

            const stored = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(stored.metadata?.claudeRewind?.hubCutApplied).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('does not broadcast the CLI metadata update when the marker write is a no-op', async () => {
        const store = new Store(':memory:')
        const cliUpdates: Array<{ room: string; event: string; update: any }> = []
        const io = {
            of: () => ({
                to: (room: string) => ({
                    emit: (event: string, update: any) => cliUpdates.push({ room, event, update })
                })
            })
        }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('claude-rewind-cut-noop', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                // Model the idempotent second cut: the intent already carries
                // the marker, so the marker write is a no-op return.
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                        hubCutApplied: true,
                    },
                }, (stored?.metadataVersion ?? 1) as number, 'default')
                ;(engine as any).sessionCache.refreshSession(session.id)
                return { success: true, truncateFromLocalId: 'local-t2' }
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })
            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).not.toContain('local-t2')
            expect(cliUpdates).toEqual([])
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('does not broadcast the CLI metadata update when the marker write exhausts its version-mismatch retries', async () => {
        const store = new Store(':memory:')
        const cliUpdates: Array<{ room: string; event: string; update: any }> = []
        const io = {
            of: () => ({
                to: (room: string) => ({
                    emit: (event: string, update: any) => cliUpdates.push({ room, event, update })
                })
            })
        }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('claude-rewind-cut-version-mismatch', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            // Model a concurrent writer that keeps advancing the stored
            // version: every marker-write attempt loses the race and returns
            // version-mismatch.
            const realUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
            ;(store.sessions as any).updateSessionMetadata = (
                id: string, metadata: any, expectedVersion: number, namespace: string, options?: any
            ) => {
                if (metadata?.claudeRewind?.hubCutApplied === true) {
                    return { result: 'version-mismatch' }
                }
                return realUpdate(id, metadata, expectedVersion, namespace, options)
            }

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                // The runner persisted the durable intent before the restart
                // teardown; the flush that gates the RPC reply made it visible.
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
                return { success: true, truncateFromLocalId: 'local-t2' }
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })
            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).not.toContain('local-t2')
            const after = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(after.metadata?.claudeRewind?.hubCutApplied).not.toBe(true)
            expect(cliUpdates).toEqual([])
        } finally {
            engine.stop()
            store.close()
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

    it('keeps the rejection error and does not cut when no matching persisted rewind intent exists', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-rejected-flush', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: false,
                outcome: 'rejected',
                error: 'Rewind intent could not be persisted'
            })

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

    it('clears a stale uncommitted rewind intent for another target when the CLI rejects the rewind', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-rejected-stale-intent', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                // A stale uncommitted intent for a different target is not this
                // rewind's commitment; a later startup reconcile would mark the
                // transcript diverged and block history actions, so the
                // rejection still clears it.
                const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
                store.sessions.updateSessionMetadata(session.id, {
                    ...(stored?.metadata ?? {}),
                    claudeRewind: {
                        targetLocalId: 'stale-target',
                        truncateFromLocalId: 'stale-target',
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

    it('truncates once and keeps the intent when a delayed RPC rejection follows a timed-out persisted write settled locally', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-rejected-after-settle', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            let resolveRpc!: (value: {
                success: false
                outcome: 'rejected'
                error: string
            }) => void
            ;(engine as any).rpcGateway.rewindConversation = () => new Promise((resolve) => {
                // The CLI's flush timed out, so it aborted the retrying write
                // and released the local launch. A waiting local spawn
                // refreshed metadata, saw this intent, and settled the rewind
                // (armed its boundary) - the persisted intent landed even
                // though the reply will later report a rejection.
                const stored = store.sessions.getSession(session.id) as {
                    metadataVersion?: number
                    metadata?: Record<string, unknown>
                }
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
                resolveRpc = resolve
            })

            const rewindPromise = engine.rewindConversation(session.id, 'default', 'local-t2')
            await new Promise((resolve) => setTimeout(resolve, 10))

            // The local launch settled from metadata: the intent is visible
            // and the hub transcript is still intact while the RPC hangs.
            expect((engine.getSession(session.id)?.metadata as Record<string, unknown> | null)?.claudeRewind).toBeTruthy()
            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).toContain('local-t2')

            resolveRpc({ success: false, outcome: 'rejected', error: 'Rewind intent could not be persisted' })

            // A rejection must not delete an intent that local settlement
            // already consumed: the native branch is armed from it, so the
            // hub transcript cut is committed and the outcome is success.
            await expect(rewindPromise).resolves.toEqual({ type: 'success' })

            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')
            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).claudeRewind).toBeTruthy()
            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).conversationHistoryDiverged).not.toBe(true)

            // Later conversation survives: the cut is idempotent and must not
            // run again for the settled intent.
            const laterPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'after settled rewind' }, 'local-t3')
            store.messages.markMessagesInvoked(session.id, ['local-t3'], Date.now())
            const laterReply = store.messages.addMessage(session.id, agentText('OK, after settled rewind'))
            const survivingIds = new Set(store.messages.getAllMessages(session.id).map((m) => m.id))
            expect(survivingIds.has(laterPrompt.id)).toBe(true)
            expect(survivingIds.has(laterReply.id)).toBe(true)
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

    it('marks the lost-RPC cut and preserves post-rewind input when the reply never reaches the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-rewind-lost-reply', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            // The runner persisted the durable intent BEFORE starting its
            // restart teardown, then the connection dropped: the RPC reply is
            // lost but the intent is visible. The cut happens here, so this
            // hub process must record the commitment for the CLI.
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
                throw new Error('rpc gateway timeout')
            }

            await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })

            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')

            const stored = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(stored.metadata?.claudeRewind?.hubCutApplied).toBe(true)
            expect(stored.metadata?.conversationHistoryDiverged).not.toBe(true)

            // The user continues after the reconnect: the post-rewind input
            // must survive both the cut and any later reconcile pass.
            const laterPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'after rewind' }, 'local-t3')
            store.messages.markMessagesInvoked(session.id, ['local-t3'], Date.now())
            const laterReply = store.messages.addMessage(session.id, agentText('OK, after rewind'))
            ;(engine as any).reconcilePendingClaudeRewind(engine.getSession(session.id))

            const rows = store.messages.getAllMessages(session.id)
            const ids = new Set(rows.map((m) => m.id))
            expect(ids.has(laterPrompt.id)).toBe(true)
            expect(ids.has(laterReply.id)).toBe(true)
            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, any>).conversationHistoryDiverged).not.toBe(true)
        } finally {
            engine.stop()
        }
    })

    for (const outcome of ['resolves', 'rejects'] as const) {
        it(`cuts only the range discarded at dispatch when the rewind RPC ${outcome} after post-rewind input arrived`, async () => {
            const { store, engine } = createEngine()
            try {
                const session = engine.getOrCreateSession(`claude-rewind-bounded-${outcome}`, {
                    path: '/tmp/project', host: 'localhost', flavor: 'claude',
                    capabilities: { conversationHistory: { rewindToMessage: true } },
                    claudeSessionId: 'native-session-1',
                }, null, 'default')
                engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
                seedTwoTurns(store, session)
                const maxSeqAtDispatch = Math.max(...store.messages.getAllMessages(session.id).map((m) => m.seq))
                const added: { prompt?: { id: string }; reply?: { id: string } } = {}
                let rpcParams: Record<string, unknown> | undefined

                ;(engine as any).rpcGateway.rewindConversation = async (_sid: string, params: Record<string, unknown>) => {
                    rpcParams = params
                    // The runner persisted the intent, restarted, and the user
                    // already continued the conversation natively before this
                    // RPC settles: the new prompt and its reply are on the hub.
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
                    added.prompt = store.messages.addMessage(session.id, { role: 'user', content: 'after the rewind' }, 'local-new')
                    store.messages.markMessagesInvoked(session.id, ['local-new'], Date.now())
                    added.reply = store.messages.addMessage(session.id, agentText('OK, after the rewind'))
                    if (outcome === 'rejects') throw new Error('rpc gateway timeout')
                    return { success: true, truncateFromLocalId: 'local-t2' }
                }

                await expect(engine.rewindConversation(session.id, 'default', 'local-t2')).resolves.toEqual({ type: 'success' })

                const rows = store.messages.getAllMessages(session.id)
                const ids = new Set(rows.map((m) => m.id))
                expect(rows.map((m) => m.localId)).not.toContain('local-t2')
                expect(rows.map((m) => m.localId)).toContain('local-t1')
                expect(ids.has(added.prompt!.id)).toBe(true)
                expect(ids.has(added.reply!.id)).toBe(true)
                expect(rpcParams?.discardedThroughSeq).toBe(maxSeqAtDispatch)
            } finally {
                engine.stop()
            }
        })
    }

    it('bounds the startup reconcile cut with the discarded range persisted on the intent', () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        try {
            const session = engine1.getOrCreateSession('claude-rewind-startup-bound', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)
            const discardedThroughSeq = Math.max(...store.messages.getAllMessages(session.id).map((m) => m.seq))
            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            store.sessions.updateSessionMetadata(session.id, {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    targetLocalId: 'local-t2',
                    truncateFromLocalId: 'local-t2',
                    keepBoundary: 'native-boundary-uuid',
                    droppedPrompts: ['native-prompt-uuid'],
                    discardedThroughSeq,
                },
            }, (stored?.metadataVersion ?? 1) as number, 'default')
            // The hub was down while the user continued after the rewind.
            const newPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'after rewind' }, 'local-new')
            store.messages.markMessagesInvoked(session.id, ['local-new'], Date.now())
            const newReply = store.messages.addMessage(session.id, agentText('OK, after rewind'))
            engine1.stop()

            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

            const rows = store.messages.getAllMessages(session.id)
            expect(rows.map((m) => m.localId)).not.toContain('local-t2')
            expect(rows.map((m) => m.id)).toContain(newPrompt.id)
            expect(rows.map((m) => m.id)).toContain(newReply.id)
            const after = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(after.metadata?.claudeRewind?.hubCutApplied).toBe(true)
            expect(after.metadata?.claudeRewind?.discardedThroughSeq).toBe(discardedThroughSeq)
        } finally {
            engine1.stop()
            engine2?.stop()
            store.close()
        }
    })

    it('preserves queued input newer than the rewind bound during startup reconcile', () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        try {
            const session = engine1.getOrCreateSession('claude-rewind-startup-bound-queued', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)
            const discardedThroughSeq = Math.max(...store.messages.getAllMessages(session.id).map((m) => m.seq))
            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            store.sessions.updateSessionMetadata(session.id, {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    targetLocalId: 'local-t2',
                    truncateFromLocalId: 'local-t2',
                    keepBoundary: 'native-boundary-uuid',
                    droppedPrompts: ['native-prompt-uuid'],
                    discardedThroughSeq,
                },
            }, (stored?.metadataVersion ?? 1) as number, 'default')
            // The hub was down while the user queued newer input: its seq is
            // past the discarded range, so it must survive the recovery cut.
            const queued = store.messages.addMessage(session.id, { role: 'user', content: 'queued after the bound' }, 'local-queued')
            engine1.stop()

            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

            const rows = store.messages.getAllMessages(session.id)
            expect(rows.map((m) => m.localId)).not.toContain('local-t2')
            expect(rows.map((m) => m.localId)).toContain('local-t1')
            expect(rows.map((m) => m.id)).toContain(queued.id)
            const after = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(after.metadata?.claudeRewind?.hubCutApplied).toBe(true)
            expect(after.metadata?.conversationHistoryDiverged).not.toBe(true)
        } finally {
            engine1.stop()
            engine2?.stop()
            store.close()
        }
    })

    it('still marks diverged when an uninvoked queued row sits inside the rewind bound', () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        try {
            const session = engine1.getOrCreateSession('claude-rewind-startup-bound-inside', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)
            // Queued before dispatch: inside the discarded range, so the
            // recovery cut must not run against this transcript.
            store.messages.addMessage(session.id, { role: 'user', content: 'queued before dispatch' }, 'local-queued')
            const discardedThroughSeq = Math.max(...store.messages.getAllMessages(session.id).map((m) => m.seq))
            const stored = store.sessions.getSession(session.id) as { metadataVersion?: number; metadata?: Record<string, unknown> }
            store.sessions.updateSessionMetadata(session.id, {
                ...(stored?.metadata ?? {}),
                claudeRewind: {
                    targetLocalId: 'local-t2',
                    truncateFromLocalId: 'local-t2',
                    keepBoundary: 'native-boundary-uuid',
                    droppedPrompts: ['native-prompt-uuid'],
                    discardedThroughSeq,
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
            store.close()
        }
    })

    it('marks the intent when a startup reconcile finds the cut already applied and preserves post-rewind input', () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        try {
            const session = engine1.getOrCreateSession('claude-rewind-reconcile-marked', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)

            // Crash window: the intent landed and the hub cut the transcript,
            // then the process died before the CLI's proof could clear it. On
            // restart the boundary is already gone - the branch this test
            // pins - and no RPC in flight owns the cut.
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
            store.messages.truncateMessagesFromLocalId(session.id, 'local-t2')
            engine1.stop()

            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

            const after = store.sessions.getSession(session.id) as { metadata?: Record<string, any> }
            expect(after.metadata?.claudeRewind?.hubCutApplied).toBe(true)
            expect(after.metadata?.conversationHistoryDiverged).not.toBe(true)
            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')
        } finally {
            engine1.stop()
            engine2?.stop()
            store.close()
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

    it('reconciles a claudeRewind intent persisted via update-metadata retry after hub restart and keeps later messages', async () => {
        const store = new Store(':memory:')
        const engine1 = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        let engine2: SyncEngine | null = null
        let engine3: SyncEngine | null = null
        const rpcHolder: { release?: () => void } = {}

        try {
            const session = engine1.getOrCreateSession('claude-rewind-late-intent', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine1.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)
            const initialVersion = store.sessions.getSession(session.id)!.metadataVersion

            // Hub 1 dispatches rewind RPC, then crashes/restarts before the CLI's
            // claudeRewind metadata write lands in SQLite.
            ;(engine1 as any).rpcGateway.rewindConversation = () => new Promise((resolve) => {
                rpcHolder.release = () => resolve({ success: false, error: 'hub restarted' })
            })
            const abandonedRpc = engine1.rewindConversation(session.id, 'default', 'local-t2')
            engine1.stop()

            // Hub 2 starts with no claudeRewind in DB yet.
            const restart2Broadcasts: SyncEvent[] = []
            engine2 = new SyncEngine(store, {} as never, new RpcRegistry(), {
                broadcast: (event: SyncEvent) => restart2Broadcasts.push(event),
            } as never)
            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).toContain('local-t2')

            // CLI reconnects to Hub 2 and retries update-metadata with claudeRewind.
            const handlers = new Map<string, (data: unknown, ack: (result: unknown) => void) => void>()
            const socket = {
                on: (name: string, handler: (data: unknown, ack: (result: unknown) => void) => void) => handlers.set(name, handler),
                to: () => ({ emit() {} }),
            }
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(session.id)! }),
                emitAccessError() {},
                onWebappEvent: (event) => engine2!.handleRealtimeEvent(event),
            })

            const storedBeforeRetry = store.sessions.getSession(session.id)!
            let ack: unknown
            handlers.get('update-metadata')!({
                sid: session.id,
                expectedVersion: initialVersion,
                metadata: {
                    ...(storedBeforeRetry.metadata as Record<string, unknown>),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                },
            }, (result) => {
                ack = result
            })

            expect(ack).toMatchObject({ result: 'success' })
            const afterCutLocalIds = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(afterCutLocalIds).toContain('local-t1')
            expect(afterCutLocalIds).not.toContain('local-t2')
            expect(restart2Broadcasts.filter((e) => e.type === 'messages-invalidated').length).toBe(1)

            // User sends a new message after the late cut and another metadata update arrives
            // while claudeRewind is still present; truncation must not run again.
            const laterPrompt = store.messages.addMessage(session.id, { role: 'user', content: 'after late rewind' }, 'local-t3')
            store.messages.markMessagesInvoked(session.id, ['local-t3'], Date.now())
            const laterReply = store.messages.addMessage(session.id, agentText('OK, after late rewind'))

            const storedBeforeSecondUpdate = store.sessions.getSession(session.id)!
            handlers.get('update-metadata')!({
                sid: session.id,
                expectedVersion: storedBeforeSecondUpdate.metadataVersion,
                metadata: {
                    ...(storedBeforeSecondUpdate.metadata as Record<string, unknown>),
                    name: 'Updated title after late rewind',
                },
            }, () => {})

            engine2.stop()
            const restart3Broadcasts: SyncEvent[] = []
            engine3 = new SyncEngine(store, {} as never, new RpcRegistry(), {
                broadcast: (event: SyncEvent) => restart3Broadcasts.push(event),
            } as never)

            const survivingIds = new Set(store.messages.getAllMessages(session.id).map((m) => m.id))
            expect(survivingIds.has(laterPrompt.id)).toBe(true)
            expect(survivingIds.has(laterReply.id)).toBe(true)
            expect(restart2Broadcasts.filter((e) => e.type === 'messages-invalidated').length).toBe(1)
            expect(restart3Broadcasts.some((e) => e.type === 'messages-invalidated')).toBe(false)

            rpcHolder.release?.()
            await abandonedRpc
        } finally {
            rpcHolder.release?.()
            engine1.stop()
            engine2?.stop()
            engine3?.stop()
            store.close()
        }
    })

    it('does not truncate during an in-flight rewind RPC and truncates on a rejection whose matching intent settled locally', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

        try {
            const session = engine.getOrCreateSession('claude-rewind-inflight-rejected', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            seedTwoTurns(store, session)

            const handlers = new Map<string, (data: unknown, ack: (result: unknown) => void) => void>()
            const socket = {
                on: (name: string, handler: (data: unknown, ack: (result: unknown) => void) => void) => handlers.set(name, handler),
                to: () => ({ emit() {} }),
            }
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(session.id)! }),
                emitAccessError() {},
                onWebappEvent: (event) => engine.handleRealtimeEvent(event),
            })

            let resolveRpc!: (value: { success: false; outcome: 'rejected'; error: string }) => void
            ;(engine as any).rpcGateway.rewindConversation = () => new Promise((resolve) => {
                resolveRpc = resolve
            })

            const rewindPromise = engine.rewindConversation(session.id, 'default', 'local-t2')

            // While the RPC is in flight on this hub process, update-metadata
            // writes claudeRewind for this same rewind. Hub must wait for the
            // in-flight RPC outcome rather than truncating early - and once a
            // rejection arrives, the visible intent is already committed on the
            // native side (the CLI settled from it), so the hub follows it.
            const storedBefore = store.sessions.getSession(session.id)!
            handlers.get('update-metadata')!({
                sid: session.id,
                expectedVersion: storedBefore.metadataVersion,
                metadata: {
                    ...(storedBefore.metadata as Record<string, unknown>),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                },
            }, () => {})

            expect(store.messages.getAllMessages(session.id).map((m) => m.localId)).toContain('local-t2')

            resolveRpc({ success: false, outcome: 'rejected', error: 'Rewind intent could not be persisted' })
            const result = await rewindPromise

            expect(result).toEqual({ type: 'success' })
            const kept = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(kept).toContain('local-t1')
            expect(kept).not.toContain('local-t2')
            expect((store.sessions.getSession(session.id)?.metadata as Record<string, unknown>).claudeRewind).toBeTruthy()
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('marks history diverged when a late update-metadata claudeRewind arrives alongside uninvoked queued messages', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)

        try {
            const session = engine.getOrCreateSession('claude-rewind-late-unsafe', {
                path: '/tmp/project', host: 'localhost', flavor: 'claude',
                capabilities: { conversationHistory: { rewindToMessage: true } },
                claudeSessionId: 'native-session-1',
            }, null, 'default')
            seedTwoTurns(store, session)
            store.messages.addMessage(session.id, { role: 'user', content: 'queued before reconnect' }, 'local-queued')

            const handlers = new Map<string, (data: unknown, ack: (result: unknown) => void) => void>()
            const socket = {
                on: (name: string, handler: (data: unknown, ack: (result: unknown) => void) => void) => handlers.set(name, handler),
                to: () => ({ emit() {} }),
            }
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(session.id)! }),
                emitAccessError() {},
                onWebappEvent: (event) => engine.handleRealtimeEvent(event),
            })

            const storedBefore = store.sessions.getSession(session.id)!
            handlers.get('update-metadata')!({
                sid: session.id,
                expectedVersion: storedBefore.metadataVersion,
                metadata: {
                    ...(storedBefore.metadata as Record<string, unknown>),
                    claudeRewind: {
                        targetLocalId: 'local-t2',
                        truncateFromLocalId: 'local-t2',
                        keepBoundary: 'native-boundary-uuid',
                        droppedPrompts: ['native-prompt-uuid'],
                    },
                },
            }, () => {})

            expect(((engine.getSession(session.id)?.metadata ?? {}) as Record<string, unknown>).conversationHistoryDiverged).toBe(true)
            const localIds = store.messages.getAllMessages(session.id).map((m) => m.localId)
            expect(localIds).toContain('local-t1')
            expect(localIds).toContain('local-t2')
            expect(localIds).toContain('local-queued')
        } finally {
            engine.stop()
            store.close()
        }
    })
})