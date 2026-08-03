import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('Pi conversation-history hub integration', () => {
    it('returns 409-style deterministic rewind rejection without marking history diverged', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('pi-rewind-rejected', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(session.id, { role: 'user', content: 'boundary' }, 'local-boundary')
            store.messages.markMessagesInvoked(session.id, ['local-boundary'], Date.now())
            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: false,
                error: 'Pi rewind was cancelled',
                outcome: 'cancelled',
            })

            await expect(engine.rewindConversation(session.id, 'default', 'local-boundary')).resolves.toEqual({
                type: 'error', message: 'Pi rewind was cancelled',
            })
            expect(engine.getSession(session.id)?.metadata?.conversationHistoryDiverged).not.toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('shares exact-native bind logic while requiring Pi native-ready but not Grok ready', async () => {
        const { engine } = createEngine()
        try {
            const pi = engine.getOrCreateSession('pi-child', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-native',
            }, null, 'default')
            const grok = engine.getOrCreateSession('grok-child', {
                path: '/tmp/project', host: 'localhost', flavor: 'grok', grokSessionId: 'grok-native',
            }, null, 'default')

            const piWait = (engine as any).waitForExactNativeForkBound(
                pi.id, 'pi-native', 'piSessionId', true
            )
            expect(await (engine as any).waitForExactNativeForkBound(
                grok.id, 'grok-native', 'grokSessionId', false
            )).toBe(true)

            engine.handleSessionReady({ sid: pi.id, time: Date.now() })
            expect(await piWait).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('copies Pi entry-id locators into a fork child and requires exact native-ready binding', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('pi-source', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'pi',
                piSessionId: 'pi-source-native',
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { local1: true, local2: true },
                conversationHistoryEntryIds: { local1: 'entry-1', local2: 'entry-2' },
            }, null, 'default', 'source-model', 'high')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'one' }, 'local1')
            store.messages.addMessage(source.id, { role: 'user', content: 'two' }, 'local2')
            store.messages.markMessagesInvoked(source.id, ['local1', 'local2'], Date.now())
            // Keep the cache fixture explicit; this is the source used by the
            // fork prefix copy path after metadata normalization.
            ;(engine.getSession(source.id)!.metadata as any).conversationHistoryEntryIds = {
                local1: 'entry-1', local2: 'entry-2',
            }

            ;(engine as any).rpcGateway.forkConversation = async () => {
                store.messages.addMessage(source.id, { role: 'user', content: 'latest' }, 'local3')
                store.messages.markMessagesInvoked(source.id, ['local3'], Date.now())
                const current = store.sessions.getSession(source.id)!
                store.sessions.updateSessionMetadata(
                    source.id,
                    {
                        ...(current.metadata as Record<string, unknown>),
                        conversationHistoryPoints: { ...((current.metadata as any).conversationHistoryPoints), local3: true },
                        conversationHistoryEntryIds: { ...((current.metadata as any).conversationHistoryEntryIds), local3: 'entry-3' },
                    },
                    current.metadataVersion,
                    'default',
                    { touchUpdatedAt: false }
                )
                return { nativeSessionId: 'pi-clone-native' }
            }
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: args[12] }
            }
            const exactBinds: unknown[][] = []
            ;(engine as any).waitForExactNativeForkBound = async (...args: unknown[]) => {
                exactBinds.push(args)
                return true
            }
            let capturedChildMetadata: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    capturedChildMetadata = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(capturedChildMetadata).toMatchObject({
                flavor: 'pi',
                piSessionId: 'pi-clone-native',
                conversationHistoryEntryIds: { local1: 'entry-1', local2: 'entry-2', local3: 'entry-3' },
                conversationHistoryPoints: { local1: true, local2: true, local3: true },
            })
            expect(store.messages.getAllMessages(result.sessionId).map((message) => message.localId)).toContain('local3')
            expect(exactBinds).toEqual([[result.sessionId, 'pi-clone-native', 'piSessionId', true]])
            expect(spawnArgs[3]).toBeUndefined()
            expect(spawnArgs[9]).toBeUndefined()
            expect(engine.getSession(result.sessionId)?.model).toBeNull()
            expect(engine.getSession(result.sessionId)?.effort).toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('scrubs Pi entry-id locators when rewind truncates their HAPI messages', () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('pi-scrub', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi',
                conversationHistoryEntryIds: { keep: 'entry-keep', remove: 'entry-remove' },
                conversationHistoryPoints: { keep: true, remove: true },
            }, null, 'default')
            store.messages.addMessage(session.id, { role: 'user', content: 'keep' }, 'keep')
            ;(engine.getSession(session.id)!.metadata as any).conversationHistoryEntryIds = {
                keep: 'entry-keep', remove: 'entry-remove',
            }
            let capturedMetadata: Record<string, unknown> | undefined
            const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
            ;(store.sessions as any).updateSessionMetadata = (...args: unknown[]) => {
                capturedMetadata = args[1] as Record<string, unknown>
                return { result: 'success' }
            }
            ;(engine as any).scrubHistoryLocators(session.id, 'default')
            ;(store.sessions as any).updateSessionMetadata = originalUpdate

            expect(capturedMetadata).toMatchObject({
                conversationHistoryEntryIds: { keep: 'entry-keep' },
                conversationHistoryPoints: { keep: true },
            })
        } finally {
            engine.stop()
        }
    })
})
