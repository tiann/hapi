import { describe, expect, it, spyOn } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

function productionCodexMessage(event: Record<string, unknown>): Record<string, unknown> {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: event
        }
    }
}

function productionCodexContextResetMessage(): Record<string, unknown> {
    return {
        role: 'agent',
        content: {
            id: 'context-reset-event',
            type: 'event',
            data: {
                type: 'message',
                message: 'Context was reset'
            }
        }
    }
}

function productionCodexScope(
    role: 'parent' | 'child',
    threadId: string,
    parentThreadId?: string
): Record<string, unknown> {
    const parent = parentThreadId
        ? { parent_thread_id: parentThreadId, parentThreadId }
        : {}
    return {
        thread_id: threadId,
        threadId,
        ...parent,
        scope_role: role,
        scopeRole: role,
        scope: { role, thread_id: threadId, threadId, ...parent }
    }
}

async function runCodexResumeScenario(
    messages: Record<string, unknown>[],
    codexSessionId?: string,
    options?: {
        archived?: boolean
        concurrentMetadata?: Record<string, unknown>
    }
) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    const session = engine.getOrCreateSession(
        'session-codex-resume-from-messages',
        {
            path: '/tmp/project',
            host: 'localhost',
            machineId: 'machine-1',
            flavor: 'codex',
            ...(codexSessionId ? { codexSessionId } : {}),
            ...(options?.archived
                ? {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Context reset before exit'
                }
                : {})
        },
        null,
        'default',
        'gpt-5'
    )
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
        null,
        'default'
    )
    engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

    for (const message of messages) {
        store.messages.addMessage(session.id, message)
    }
    if (options?.concurrentMetadata) {
        const current = store.sessions.getSessionByNamespace(session.id, 'default')!
        const result = store.sessions.updateSessionMetadata(
            session.id,
            { ...current.metadata!, ...options.concurrentMetadata },
            current.metadataVersion,
            'default',
            { touchUpdatedAt: false }
        )
        if (result.result !== 'success') throw new Error('Failed to prepare stale metadata fixture')
    }
    const before = store.sessions.getSession(session.id)!
    const capturedResumeSessionIds: Array<string | undefined> = []
    ;(engine as any).rpcGateway.spawnSession = async (...args: Parameters<SyncEngine['spawnSession']>) => {
        capturedResumeSessionIds.push(args[8])
        return { type: 'success', sessionId: session.id }
    }
    ;(engine as any).waitForSessionActive = async () => true

    try {
        const result = options?.archived
            ? await engine.reopenSession(session.id, 'default')
            : await engine.resumeSession(session.id, 'default')
        const after = store.sessions.getSession(session.id)!
        return {
            result,
            capturedResumeSessionIds,
            before,
            after,
            persistedCodexSessionId: (after.metadata as { codexSessionId?: string } | null)?.codexSessionId,
            cachedCodexSessionId: engine.getSession(session.id)?.metadata?.codexSessionId
        }
    } finally {
        engine.stop()
    }
}

describe('session model', () => {
    it('includes explicit model in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        expect(session.model).toBe('gpt-5.4')
        expect(toSessionSummary(session).model).toBe('gpt-5.4')
        expect(toSessionSummary(session).effort).toBeNull()
    })

    it('includes explicit effort in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        expect(session.effort).toBe('high')
        expect(toSessionSummary(session).effort).toBe('high')
    })

    it('persists explicit model reasoning effort on Codex sessions', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-effort',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'xhigh'
        )

        expect(session.modelReasoningEffort).toBe('xhigh')
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')
    })

    it('preserves model from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-model-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-model-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('gpt-5.4')
    })

    it('deduplicates agy sessions that share an agySessionId (reopen correlation)', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'agy-dup-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'agy', agySessionId: 'brain-uuid-1' },
            null,
            'default'
        )
        const newSession = cache.getOrCreateSession(
            'agy-dup-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'agy', agySessionId: 'brain-uuid-1' },
            null,
            'default'
        )

        await cache.deduplicateByAgentSessionId(newSession.id)

        // The two rows sharing the brain UUID must collapse to one — reopen
        // reactivates the archived row instead of orphaning a duplicate. Before
        // the fix, extractAgentSessionId omitted agySessionId so it returned null
        // and nothing merged (both rows survived).
        const survivors = [oldSession.id, newSession.id].filter((id) => cache.getSession(id) != null)
        expect(survivors).toHaveLength(1)
    })

    it('preserves service tier from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-tier-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        // Fast was selected on the original session before it was resumed.
        store.sessions.setSessionServiceTier(oldSession.id, 'fast', 'default')
        const newSession = cache.getOrCreateSession(
            'session-tier-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.sessions.getSession(newSession.id)?.serviceTier).toBe('fast')
    })

    it('persists applied session model updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.applySessionConfig(session.id, { model: 'opus[1m]' })
        expect(cache.getSession(session.id)?.model).toBe('opus[1m]')
        expect(store.sessions.getSession(session.id)?.model).toBe('opus[1m]')

        cache.applySessionConfig(session.id, { model: null })
        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('ignores stale keepalive model values after an applied config update', () => {
        const originalDateNow = Date.now
        let now = 1_780_000_000_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-model-stale-heartbeat',
                { path: '/tmp/project', host: 'localhost', flavor: 'cursor' },
                null,
                'default',
                'composer-2.5[fast=true]'
            )

            const staleKeepAliveTime = now
            now += 1_000
            cache.applySessionConfig(session.id, { model: 'gpt-5.5[reasoning=medium]' })

            cache.handleSessionAlive({
                sid: session.id,
                time: staleKeepAliveTime,
                thinking: false,
                model: 'composer-2.5[fast=true]'
            })

            expect(cache.getSession(session.id)?.model).toBe('gpt-5.5[reasoning=medium]')
            expect(store.sessions.getSession(session.id)?.model).toBe('gpt-5.5[reasoning=medium]')

            now += 1_000
            cache.handleSessionAlive({
                sid: session.id,
                time: now,
                thinking: false,
                model: 'claude-opus-4-8[effort=high]'
            })

            expect(cache.getSession(session.id)?.model).toBe('claude-opus-4-8[effort=high]')
        } finally {
            Date.now = originalDateNow
        }
    })

    it('syncs cursor spawn model to resolved ACP wire id via keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-cursor-spawn-model',
            { path: '/tmp/project', host: 'localhost', flavor: 'cursor' },
            null,
            'default',
            'composer-2.5'
        )

        expect(session.model).toBe('composer-2.5')

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            model: 'composer-2.5[fast=true]'
        })

        expect(cache.getSession(session.id)?.model).toBe('composer-2.5[fast=true]')
        expect(store.sessions.getSession(session.id)?.model).toBe('composer-2.5[fast=true]')
    })

    it('passes cursor spawn model to runner when spawning a remote session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-cursor',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-cursor', time: Date.now() })

            let capturedModel: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                agent: string,
                model?: string
            ) => {
                capturedModel = model
                return { type: 'success', sessionId: 'spawned-cursor-session' }
            }

            const result = await engine.spawnSession(
                'machine-cursor',
                '/tmp/project',
                'cursor',
                'composer-2.5[fast=false]'
            )

            expect(result).toEqual({ type: 'success', sessionId: 'spawned-cursor-session' })
            expect(capturedModel).toBe('composer-2.5[fast=false]')
        } finally {
            engine.stop()
        }
    })

    it('persists keepalive model changes, including clearing the model', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            model: null
        })

        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists applied session effort updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'medium'
        )

        cache.applySessionConfig(session.id, { effort: 'max' })
        expect(cache.getSession(session.id)?.effort).toBe('max')
        expect(store.sessions.getSession(session.id)?.effort).toBe('max')

        cache.applySessionConfig(session.id, { effort: null })
        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('persists applied session model reasoning effort updates, including clear-to-default', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'high'
        )

        cache.applySessionConfig(session.id, { modelReasoningEffort: 'xhigh' })
        expect(cache.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBe('xhigh')

        cache.applySessionConfig(session.id, { modelReasoningEffort: null })
        expect(cache.getSession(session.id)?.modelReasoningEffort).toBeNull()
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBeNull()
    })

    it('persists keepalive effort changes, including clearing the effort', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-effort-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet',
            'high'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            effort: null
        })

        expect(cache.getSession(session.id)?.effort).toBeNull()
        expect(store.sessions.getSession(session.id)?.effort).toBeNull()
    })

    it('persists keepalive model reasoning effort changes, including clearing the value', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-reasoning-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4',
            undefined,
            'high'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            modelReasoningEffort: null
        })

        expect(cache.getSession(session.id)?.modelReasoningEffort).toBeNull()
        expect(store.sessions.getSession(session.id)?.modelReasoningEffort).toBeNull()
    })

    it('tracks collaboration mode updates in memory from config and keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-collaboration-mode',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        cache.applySessionConfig(session.id, { collaborationMode: 'plan' })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('plan')

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            collaborationMode: 'default'
        })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('default')
    })

    it('touches session updatedAt when new message activity is recorded', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-message-activity',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const activityAt = session.updatedAt + 60_000

        cache.recordSessionActivity(session.id, activityAt)

        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(activityAt)
        expect(cache.getSession(session.id)?.updatedAt).toBe(activityAt)
        expect(events).toContainEqual({
            type: 'session-updated',
            sessionId: session.id,
            namespace: 'default',
            data: { updatedAt: activityAt }
        })
    })

    it('rejects active session config updates when CLI ignores requested keys', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-config-ignored',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                null,
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            ;(engine as any).rpcGateway.requestSessionConfig = async () => ({ applied: {} })

            await expect(
                engine.applySessionConfig(session.id, { modelReasoningEffort: 'high' })
            ).rejects.toThrow('Session did not apply modelReasoningEffort')
            expect(engine.getSession(session.id)?.modelReasoningEffort).toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('touches session updatedAt when web sends a message through sync engine', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-web-message-activity',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            const before = store.sessions.getSession(session.id)?.updatedAt ?? 0

            await new Promise((resolve) => setTimeout(resolve, 2))
            await engine.sendMessage(session.id, { text: 'hello' })

            const after = store.sessions.getSession(session.id)?.updatedAt ?? 0
            expect(after).toBeGreaterThan(before)
            expect(engine.getSession(session.id)?.updatedAt).toBe(after)
        } finally {
            engine.stop()
        }
    })

    it('records CLI user text activity but stores and broadcasts ready without recording activity', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'session-cli-message-activity',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const handlers = new Map<string, (payload: unknown) => void>()
        const activity: Array<{ sessionId: string; updatedAt: number }> = []
        const roomEvents: unknown[] = []

        registerSessionHandlers({
            on: (event: string, handler: (payload: unknown) => void) => {
                handlers.set(event, handler)
            },
            to: () => ({ emit: (_event: string, update: unknown) => roomEvents.push(update) })
        } as never, {
            store,
            resolveSessionAccess: (sessionId) => {
                const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
            },
            emitAccessError: () => {},
            onSessionActivity: (sessionId, updatedAt) => {
                activity.push({ sessionId, updatedAt })
            }
        })

        handlers.get('message')?.({
            sid: session.id,
            message: JSON.stringify({ role: 'user', content: { type: 'text', text: 'hello' } })
        })
        handlers.get('message')?.({
            sid: session.id,
            message: JSON.stringify({
                role: 'agent',
                content: {
                    type: 'event',
                    data: { type: 'ready' }
                }
            })
        })

        const messages = store.messages.getMessages(session.id)
        expect(messages).toHaveLength(2)
        expect(roomEvents).toHaveLength(2)
        expect(activity).toHaveLength(1)
        expect(activity[0].sessionId).toBe(session.id)
        expect(activity[0].updatedAt).toBe(messages[0]?.createdAt)
    })

    it('records activity only for the first messages-consumed transition while retaining duplicate acknowledgements', () => {
        const originalDateNow = Date.now
        let now = 1_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-cli-consumed-activity',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            const queued = store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-activity'
            )
            const handlers = new Map<string, (payload: unknown) => void>()
            const activity: Array<{ sessionId: string; updatedAt: number }> = []
            const webEvents: SyncEvent[] = []

            registerSessionHandlers({
                on: (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler)
                },
                to: () => ({ emit() {} })
            } as never, {
                store,
                resolveSessionAccess: (sessionId) => {
                    const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                    return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
                },
                emitAccessError: () => {},
                onSessionActivity: (sessionId, updatedAt) => {
                    activity.push({ sessionId, updatedAt })
                    cache.recordSessionActivity(sessionId, updatedAt)
                },
                onWebappEvent: (event) => webEvents.push(event)
            })

            now = 2_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-activity'] })
            now = 3_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-activity'] })
            now = 4_000
            handlers.get('message')?.({
                sid: session.id,
                message: JSON.stringify({
                    role: 'agent',
                    content: { type: 'event', data: { type: 'ready' } }
                })
            })

            const invoked = store.messages.getMessages(session.id).find((message) => message.id === queued.id)
            expect(invoked?.invokedAt).toBe(2_000)
            expect(activity).toEqual([
                { sessionId: session.id, updatedAt: 2_000 },
                { sessionId: session.id, updatedAt: 2_000 }
            ])
            expect(store.sessions.getSession(session.id)?.updatedAt).toBe(2_000)
            expect(events.filter((event) => event.type === 'session-updated')).toHaveLength(1)
            expect(webEvents.filter((event) => event.type === 'messages-consumed')).toHaveLength(2)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('replays the persisted invocation timestamp after the first activity callback fails', () => {
        const originalDateNow = Date.now
        const originalConsoleError = console.error
        let now = 1_000
        Date.now = () => now
        console.error = () => {}
        try {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession(
                'session-cli-consumed-replay',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-replay'
            )
            const handlers = new Map<string, (payload: unknown) => void>()
            const activity: Array<{ sessionId: string; updatedAt: number }> = []
            const webEvents: SyncEvent[] = []
            let failActivity = true

            registerSessionHandlers({
                on: (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler)
                },
                to: () => ({ emit() {} })
            } as never, {
                store,
                resolveSessionAccess: (sessionId) => {
                    const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                    return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
                },
                emitAccessError: () => {},
                onSessionActivity: (sessionId, updatedAt) => {
                    if (failActivity) throw new Error('activity callback failed')
                    activity.push({ sessionId, updatedAt })
                },
                onWebappEvent: (event) => webEvents.push(event)
            })

            now = 2_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-replay'] })
            failActivity = false
            now = 3_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-replay'] })

            expect(store.messages.getLocalMessageStates(session.id, ['local-replay']))
                .toEqual([{ localId: 'local-replay', invokedAt: 2_000 }])
            expect(store.sessions.getSession(session.id)?.updatedAt).toBe(2_000)
            expect(activity).toEqual([{ sessionId: session.id, updatedAt: 2_000 }])
            expect(webEvents.filter((event) => event.type === 'messages-consumed').map((event) => event.invokedAt))
                .toEqual([2_000, 3_000])
        } finally {
            Date.now = originalDateNow
            console.error = originalConsoleError
        }
    })

    it('uses the newest persisted invocation timestamp for a partial messages-consumed batch', () => {
        const originalDateNow = Date.now
        let now = 1_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession(
                'session-cli-consumed-partial',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'old' } }, 'local-old')
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'fresh' } }, 'local-fresh')
            store.messages.markMessagesInvoked(session.id, ['local-old'], 1_500)
            const handlers = new Map<string, (payload: unknown) => void>()
            const activity: Array<{ sessionId: string; updatedAt: number }> = []
            const webEvents: SyncEvent[] = []

            registerSessionHandlers({
                on: (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler)
                },
                to: () => ({ emit() {} })
            } as never, {
                store,
                resolveSessionAccess: (sessionId) => {
                    const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                    return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
                },
                emitAccessError: () => {},
                onSessionActivity: (sessionId, updatedAt) => activity.push({ sessionId, updatedAt }),
                onWebappEvent: (event) => webEvents.push(event)
            })

            now = 2_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-old', 'local-fresh'] })

            expect(store.messages.getLocalMessageStates(session.id, ['local-old', 'local-fresh']))
                .toEqual([
                    { localId: 'local-old', invokedAt: 1_500 },
                    { localId: 'local-fresh', invokedAt: 2_000 }
                ])
            expect(activity).toEqual([{ sessionId: session.id, updatedAt: 2_000 }])
            expect(webEvents.filter((event) => event.type === 'messages-consumed').map((event) => event.invokedAt))
                .toEqual([2_000])
        } finally {
            Date.now = originalDateNow
        }
    })

    it('keeps the batch ACK timestamp for heterogeneous sibling-preinvoked and unknown IDs', () => {
        const originalDateNow = Date.now
        let now = 1_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const session = cache.getOrCreateSession(
                'session-cli-consumed-sibling-preinvoked',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'already sent by sibling' } },
                'local-sibling-preinvoked'
            )
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'second sibling send' } },
                'local-sibling-preinvoked-newer'
            )
            store.messages.markMessagesInvoked(session.id, ['local-sibling-preinvoked'], 1_500)
            store.messages.markMessagesInvoked(session.id, ['local-sibling-preinvoked-newer'], 1_800)
            const handlers = new Map<string, (payload: unknown) => void>()
            const activity: Array<{ sessionId: string; updatedAt: number }> = []
            const webEvents: SyncEvent[] = []

            registerSessionHandlers({
                on: (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler)
                },
                to: () => ({ emit() {} })
            } as never, {
                store,
                resolveSessionAccess: (sessionId) => {
                    const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                    return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
                },
                emitAccessError: () => {},
                onSessionActivity: (sessionId, updatedAt) => {
                    activity.push({ sessionId, updatedAt })
                    cache.recordSessionActivity(sessionId, updatedAt)
                },
                onWebappEvent: (event) => webEvents.push(event)
            })

            now = 2_000
            handlers.get('messages-consumed')?.({
                sid: session.id,
                localIds: ['local-sibling-preinvoked', 'local-sibling-preinvoked-newer', 'local-unknown']
            })

            expect(store.messages.getLocalMessageStates(session.id, [
                'local-sibling-preinvoked',
                'local-sibling-preinvoked-newer'
            ])).toEqual([
                { localId: 'local-sibling-preinvoked', invokedAt: 1_500 },
                { localId: 'local-sibling-preinvoked-newer', invokedAt: 1_800 }
            ])
            expect(activity).toEqual([{ sessionId: session.id, updatedAt: 1_000 }])
            expect(store.sessions.getSession(session.id)?.updatedAt).toBe(1_000)
            expect(events.filter((event) => event.type === 'session-updated')).toHaveLength(0)
            expect(webEvents.filter((event) => event.type === 'messages-consumed').map((event) => event.invokedAt))
                .toEqual([2_000])
        } finally {
            Date.now = originalDateNow
        }
    })

    it('keeps the ACK timestamp for messages-consumed SSE when local IDs are unknown', () => {
        const originalDateNow = Date.now
        let now = 1_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession(
                'session-cli-consumed-unknown-id',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )
            const handlers = new Map<string, (payload: unknown) => void>()
            const webEvents: SyncEvent[] = []

            registerSessionHandlers({
                on: (event: string, handler: (payload: unknown) => void) => {
                    handlers.set(event, handler)
                },
                to: () => ({ emit() {} })
            } as never, {
                store,
                resolveSessionAccess: (sessionId) => {
                    const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                    return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
                },
                emitAccessError: () => {},
                onWebappEvent: (event) => webEvents.push(event)
            })

            now = 2_000
            handlers.get('messages-consumed')?.({ sid: session.id, localIds: ['local-unknown'] })

            expect(webEvents.filter((event) => event.type === 'messages-consumed').map((event) => event.invokedAt))
                .toEqual([2_000])
        } finally {
            Date.now = originalDateNow
        }
    })

    it('does not report session activity for CLI tool messages', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const session = cache.getOrCreateSession(
            'session-cli-tool-activity',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )
        const handlers = new Map<string, (payload: unknown) => void>()
        const activity: Array<{ sessionId: string; updatedAt: number }> = []

        registerSessionHandlers({
            on: (event: string, handler: (payload: unknown) => void) => {
                handlers.set(event, handler)
            },
            to: () => ({ emit() {} })
        } as never, {
            store,
            resolveSessionAccess: (sessionId) => {
                const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
                return stored ? { ok: true, value: stored } : { ok: false, reason: 'not-found' }
            },
            emitAccessError: () => {},
            onSessionActivity: (sessionId, updatedAt) => {
                activity.push({ sessionId, updatedAt })
            }
        })

        handlers.get('message')?.({
            sid: session.id,
            message: JSON.stringify({
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: 'call-1',
                        input: { cmd: 'date' }
                    }
                }
            })
        })
        handlers.get('message')?.({
            sid: session.id,
            message: JSON.stringify({
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'call-1',
                        output: { stdout: 'Sat Apr 25' }
                    }
                }
            })
        })

        expect(activity).toHaveLength(0)
    })

    it('passes the stored model when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModel: string | undefined
            let capturedModelReasoningEffort: string | undefined
            let capturedEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                model?: string,
                modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                effort?: string
            ) => {
                capturedModel = model
                capturedModelReasoningEffort = modelReasoningEffort
                capturedEffort = effort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModel).toBe('gpt-5.4')
            expect(capturedModelReasoningEffort).toBeUndefined()
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('passes the stored model reasoning effort when respawning a resumed Codex session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-reasoning-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4',
                undefined,
                'xhigh'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModelReasoningEffort: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                modelReasoningEffort?: string
            ) => {
                capturedModelReasoningEffort = modelReasoningEffort
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModelReasoningEffort).toBe('xhigh')
        } finally {
            engine.stop()
        }
    })

    it('marks a resumed session active in hub cache before returning success without persisting runtime active state', async () => {
        const store = new Store(':memory:')
        const events: unknown[] = []
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast(event: unknown) { events.push(event) } } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-resume-active-state',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'success', sessionId: session.id })
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(engine.getSession(session.id)?.active).toBe(true)
            // 中文注释：active=true 是运行时状态，不能跨 Hub 重启持久化；否则旧会话会在重启后假在线。
            expect(store.sessions.getSession(session.id)?.active).toBe(false)
            expect(events.some((event) => {
                const record = event as { type?: string; sessionId?: string; data?: { active?: boolean } }
                return record.type === 'session-updated'
                    && record.sessionId === session.id
                    && record.data?.active === true
            })).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('passes resume session ID to rpc gateway when resuming claude session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBe('claude-session-1')
        } finally {
            engine.stop()
        }
    })

    it('recovers claude resume session ID from stored messages when metadata is missing it', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume-from-message',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude'
                },
                null,
                'default',
                'sonnet'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        sessionId: '7f5cd4ee-3a76-4601-a7b4-f9eb976bf515'
                    }
                }
            })
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBe('7f5cd4ee-3a76-4601-a7b4-f9eb976bf515')
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                claudeSessionId: '7f5cd4ee-3a76-4601-a7b4-f9eb976bf515'
            })
        } finally {
            engine.stop()
        }
    })


    it('recovers the newest claude session ID when stored messages contain multiple IDs', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume-newest-message',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude'
                },
                null,
                'default',
                'sonnet'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        sessionId: '11111111-1111-4111-8111-111111111111'
                    }
                }
            })
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        sessionId: '22222222-2222-4222-8222-222222222222'
                    }
                }
            })
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: 'simple' | 'worktree',
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBe('22222222-2222-4222-8222-222222222222')
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
                claudeSessionId: '22222222-2222-4222-8222-222222222222'
            })
        } finally {
            engine.stop()
        }
    })

    it('does not recover a non-UUID sessionId from stored messages', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-claude-resume-no-token',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude'
                },
                null,
                'default',
                'sonnet'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        sessionId: 'hapi-session-id-not-claude-uuid'
                    }
                }
            })

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            })
        } finally {
            engine.stop()
        }
    })

    it('recovers the explicit Codex parent thread when a newer child event exists', async () => {
        const rootThreadId = '33333333-3333-4333-8333-333333333333'
        const childThreadId = '44444444-4444-4444-8444-444444444444'
        const outcome = await runCodexResumeScenario([
            productionCodexMessage({
                type: 'token_count',
                ...productionCodexScope('parent', rootThreadId)
            }),
            productionCodexMessage({
                type: 'agent-run-trace',
                ...productionCodexScope('child', childThreadId, rootThreadId)
            })
        ])

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([rootThreadId])
        expect([
            outcome.persistedCodexSessionId,
            outcome.cachedCodexSessionId,
            outcome.after.metadataVersion,
            outcome.after.updatedAt
        ]).toEqual([
            rootThreadId,
            rootThreadId,
            outcome.before.metadataVersion + 1,
            outcome.before.updatedAt
        ])
    })

    it('prefers the Codex resume ID already stored in metadata', async () => {
        const metadataThreadId = 'metadata-codex-thread'
        const messageThreadId = '55555555-5555-4555-8555-555555555555'
        const outcome = await runCodexResumeScenario(
            [productionCodexMessage(productionCodexScope('parent', messageThreadId))],
            metadataThreadId
        )

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([metadataThreadId])
        expect(outcome.after).toMatchObject({
            metadata: { codexSessionId: metadataThreadId },
            metadataVersion: outcome.before.metadataVersion,
            updatedAt: outcome.before.updatedAt
        })
    })

    it('does not recover a Codex thread from before an explicit context reset', async () => {
        const oldThreadId = '88888888-8888-4888-8888-888888888888'
        const outcome = await runCodexResumeScenario([
            productionCodexMessage(productionCodexScope('parent', oldThreadId)),
            productionCodexContextResetMessage()
        ], undefined, { archived: true })

        expect(outcome.result).toMatchObject({ type: 'error', code: 'resume_unavailable' })
        expect(outcome.capturedResumeSessionIds).toEqual([])
        expect(outcome.persistedCodexSessionId).toBeUndefined()
        expect(outcome.after.metadata).toMatchObject({
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'Context reset before exit'
        })
    })

    it('recovers a new Codex parent thread created after a context reset', async () => {
        const oldThreadId = '88888888-8888-4888-8888-888888888888'
        const newThreadId = '99999999-9999-4999-8999-999999999999'
        const outcome = await runCodexResumeScenario([
            productionCodexMessage(productionCodexScope('parent', oldThreadId)),
            productionCodexContextResetMessage(),
            productionCodexMessage(productionCodexScope('parent', newThreadId))
        ])

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([newThreadId])
        expect(outcome.persistedCodexSessionId).toBe(newThreadId)
    })

    it('does not treat raw user /clear text as a Codex context reset boundary', async () => {
        const threadId = '88888888-8888-4888-8888-888888888888'
        const outcome = await runCodexResumeScenario([
            productionCodexMessage(productionCodexScope('parent', threadId)),
            { role: 'user', content: { type: 'text', text: '/clear' } }
        ])

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([threadId])
        expect(outcome.persistedCodexSessionId).toBe(threadId)
    })

    it('prefers a Codex resume ID written concurrently during recovery persistence', async () => {
        const messageThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const concurrentThreadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        const outcome = await runCodexResumeScenario(
            [productionCodexMessage(productionCodexScope('parent', messageThreadId))],
            undefined,
            {
                concurrentMetadata: { codexSessionId: concurrentThreadId }
            }
        )

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([concurrentThreadId])
        expect([
            outcome.persistedCodexSessionId,
            outcome.cachedCodexSessionId,
            outcome.after.metadataVersion,
            outcome.after.updatedAt
        ]).toEqual([
            concurrentThreadId,
            concurrentThreadId,
            outcome.before.metadataVersion,
            outcome.before.updatedAt
        ])
    })

    it('retries Codex recovery persistence after an unrelated concurrent metadata write', async () => {
        const messageThreadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        const outcome = await runCodexResumeScenario(
            [productionCodexMessage(productionCodexScope('parent', messageThreadId))],
            undefined,
            {
                concurrentMetadata: { name: 'Concurrent rename' }
            }
        )

        expect(outcome.result).toEqual({ type: 'success', sessionId: outcome.after.id })
        expect(outcome.capturedResumeSessionIds).toEqual([messageThreadId])
        expect(outcome.after.metadata).toMatchObject({
            codexSessionId: messageThreadId,
            name: 'Concurrent rename'
        })
        expect([
            outcome.cachedCodexSessionId,
            outcome.after.metadataVersion,
            outcome.after.updatedAt
        ]).toEqual([
            messageThreadId,
            outcome.before.metadataVersion + 1,
            outcome.before.updatedAt
        ])
    })

    const safeParentThreadId = '66666666-6666-4666-8666-666666666666'
    const otherThreadId = '77777777-7777-4777-8777-777777777777'
    const explicitParentEvent = productionCodexScope('parent', safeParentThreadId)
    const rejectedCodexRecoveryCases: Array<[string, Record<string, unknown>[]]> = [
        ['child-only event, including parent_thread_id', [
            productionCodexMessage(productionCodexScope('child', otherThreadId, safeParentThreadId))
        ]],
        ['roleless event', [productionCodexMessage({
            thread_id: safeParentThreadId,
            scope: { threadId: safeParentThreadId }
        })]],
        ['malformed UUID', [productionCodexMessage(productionCodexScope('parent', 'not-a-uuid'))]],
        ['conflicting role aliases', [productionCodexMessage({
            ...explicitParentEvent,
            scopeRole: 'child'
        })]],
        ['conflicting thread IDs', [productionCodexMessage({
            ...explicitParentEvent,
            scope: { role: 'parent', thread_id: otherThreadId, threadId: otherThreadId }
        })]],
        ['valid and malformed thread aliases', [productionCodexMessage({
            ...explicitParentEvent,
            threadId: 'not-a-uuid'
        })]],
        ['unrelated nested payload', [productionCodexMessage({ payload: explicitParentEvent })]],
        ['non-production outer envelopes', [
            { role: 'user', content: { type: 'codex', data: explicitParentEvent } },
            { role: 'agent', content: { type: 'output', data: explicitParentEvent } }
        ]]
    ]

    it.each(rejectedCodexRecoveryCases)('does not recover a Codex resume ID from %s', async (name, messages) => {
        const outcome = await runCodexResumeScenario(messages)

        expect(outcome.result).toMatchObject({ type: 'error', code: 'resume_unavailable' })
        expect([
            outcome.capturedResumeSessionIds,
            outcome.persistedCodexSessionId,
            outcome.after.metadataVersion,
            outcome.after.updatedAt
        ]).toEqual([[], undefined, outcome.before.metadataVersion, outcome.before.updatedAt])
    })

    it('does not let stale default resume option override persisted Codex yolo', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-codex-yolo-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1',
                    preferredPermissionMode: 'yolo'
                },
                null,
                'default',
                'gpt-5'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedPermissionMode: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedPermissionMode = permissionMode
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default', { permissionMode: 'default' })

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedPermissionMode).toBe('yolo')
        } finally {
            engine.stop()
        }
    })

    it('passes stored Copilot agent mode when respawning a resumed Copilot session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-copilot-agent-mode-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'copilot',
                    copilotSessionId: 'copilot-thread-1'
                },
                null,
                'default',
                'gpt-5'
            )
            await engine.applySessionConfig(session.id, { copilotAgentMode: 'plan' })
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedCopilotAgentMode: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                _permissionMode?: string,
                _serviceTier?: string,
                _existingSessionId?: string,
                _collaborationMode?: string,
                copilotAgentMode?: string
            ) => {
                capturedCopilotAgentMode = copilotAgentMode
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedCopilotAgentMode).toBe('plan')
        } finally {
            engine.stop()
        }
    })

    it('restores the Copilot agent mode from metadata after a hub restart', async () => {
        const store = new Store(':memory:')
        const firstEngine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const session = firstEngine.getOrCreateSession(
            'session-copilot-agent-mode-restart',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'copilot',
                copilotSessionId: 'copilot-thread-1'
            },
            null,
            'default'
        )
        await firstEngine.applySessionConfig(session.id, { copilotAgentMode: 'autopilot' })
        firstEngine.stop()

        const restartedEngine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        try {
            expect(restartedEngine.getSession(session.id)?.copilotAgentMode).toBe('autopilot')
            expect(store.sessions.getSession(session.id)?.metadata).toEqual(expect.objectContaining({
                preferredCopilotAgentMode: 'autopilot'
            }))
        } finally {
            restartedEngine.stop()
        }
    })

    it('passes the cached permissionMode when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-permission-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-perm'
                },
                null,
                'default',
                'sonnet'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            engine.handleSessionAlive({
                sid: session.id,
                permissionMode: 'bypassPermissions',
                time: Date.now()
            })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })

            let capturedPermissionMode: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedPermissionMode = permissionMode
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedPermissionMode).toBe('bypassPermissions')
        } finally {
            engine.stop()
        }
    })

    it('resume succeeds when session-alive races ahead of set-session-config and merges spawned session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'session-resume-config-race',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-race'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionAlive({
                sid: oldSession.id,
                permissionMode: 'yolo',
                time: Date.now()
            })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            const spawnedSession = engine.getOrCreateSession(
                'session-resume-config-race-spawned',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-race'
                },
                null,
                'default',
                'gpt-5.4'
            )
            const spawnedSessionId = spawnedSession.id
            let configRpcCalls = 0
            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                engine.handleSessionAlive({
                    sid: spawnedSessionId,
                    time: Date.now(),
                    permissionMode: permissionMode as never
                })
                return { type: 'success', sessionId: spawnedSessionId }
            }
            ;(engine as any).rpcGateway.requestSessionConfig = async () => {
                configRpcCalls += 1
                throw new Error('RPC handler not registered')
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: spawnedSessionId })
            expect(configRpcCalls).toBe(0)
            expect(mergeCalls).toBe(1)
            expect(engine.getSession(spawnedSessionId)?.permissionMode).toBe('yolo')
            expect(store.sessions.getSession(oldSession.id)).toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('cursor ACP resume passes existingSessionId and reuses row without session-ready wait (#991)', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-reopen-old',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-fail',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            let capturedExistingSessionId: string | undefined
            let waitForSessionReadyCalls = 0
            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }

            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                _permissionMode?: string,
                _serviceTier?: string,
                existingSessionId?: string
            ) => {
                capturedExistingSessionId = existingSessionId
                engine.handleSessionAlive({ sid: oldSession.id, time: Date.now() })
                return { type: 'success', sessionId: oldSession.id }
            }
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => ({ onDisk: true, store: 'acp' })
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => {
                waitForSessionReadyCalls += 1
                return 'timeout'
            }

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: oldSession.id })
            expect(capturedExistingSessionId).toBe(oldSession.id)
            expect(waitForSessionReadyCalls).toBe(0)
            expect(mergeCalls).toBe(0)
            expect(store.sessions.getSession(oldSession.id)).not.toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('cursor ACP resume succeeds on same row without merge (#991)', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-reopen-old-ready',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-ok',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }

            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                _permissionMode?: string,
                _serviceTier?: string,
                existingSessionId?: string
            ) => {
                expect(existingSessionId).toBe(oldSession.id)
                engine.handleSessionAlive({ sid: oldSession.id, time: Date.now() })
                return { type: 'success', sessionId: oldSession.id }
            }
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => ({ onDisk: true, store: 'acp' })
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: oldSession.id })
            expect(mergeCalls).toBe(0)
            expect(store.sessions.getSession(oldSession.id)).not.toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('reopens Pi in place only after native-ready, preserving its id and history', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-in-place', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-1',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            }, null, 'default')
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'keep history' } })
            engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, { status: 'running', capabilities: { piExistingSessionResume: true } }, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })
            let existing: string | undefined
            let merges = 0
            ;(engine as any).sessionCache.mergeSessions = async () => { merges += 1 }
            ;(engine as any).rpcGateway.spawnSession = async (...args: Parameters<SyncEngine['spawnSession']>) => {
                existing = args[12]
                engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                engine.handleSessionReady({ sid: session.id, time: Date.now() })
                return { type: 'success', sessionId: session.id }
            }
            const result = await engine.reopenSession(session.id, 'default')
            expect(result).toEqual({ type: 'success', sessionId: session.id, resumed: true })
            expect(existing).toBe(session.id)
            expect(merges).toBe(0)
            expect(store.messages.getFirstMessages(session.id, 10)).toHaveLength(1)
        } finally { engine.stop() }
    })

    it('kills and deletes an unexpected legacy Pi temp without touching the original row', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const original = engine.getOrCreateSession('pi-original', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-old',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            }, null, 'default')
            const unexpected = engine.getOrCreateSession('pi-unexpected', { path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi' }, null, 'default')
            engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, { status: 'running', capabilities: { piExistingSessionResume: true } }, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: original.id, time: Date.now() })
            ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'success', sessionId: unexpected.id })
            ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, sid: string) => {
                engine.handleSessionEnd({ sid, time: Date.now(), reason: 'error' })
                return 'stopped'
            }
            const result = await engine.reopenSession(original.id, 'default')
            expect(result).toMatchObject({ type: 'error', code: 'resume_failed', message: expect.stringContaining('upgrade') })
            expect(store.sessions.getSession(unexpected.id)).toBeNull()
            expect(store.sessions.getSession(original.id)).not.toBeNull()
            expect(engine.getSessionByNamespace(original.id, 'default')?.metadata?.lifecycleState).toBe('archived')
        } finally { engine.stop() }
    })

    it('does not restore archive metadata over a live Pi child after kill failure', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-live-failure', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-live',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            }, null, 'default')
            engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, { status: 'running', capabilities: { piExistingSessionResume: true } }, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
            const result = await engine.reopenSession(session.id, 'default')
            expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('still active') })
            expect(engine.getSessionByNamespace(session.id, 'default')?.active).toBe(true)
            // Pi keeps the persisted archive snapshot until bootstrap succeeds,
            // so a failed stop never needs to reconstruct it from memory.
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.lifecycleState).toBe('archived')
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt?.state).toBe('quarantined')
            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({ type: 'error', message: 'Pi resume is already in progress' })

            engine.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'error' })
            await flushAsyncWork()
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('rejects Pi resume before spawn when the runner lacks in-place capability', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-old-runner', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-old-runner',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            }, null, 'default')
            engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, { status: 'running' }, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })
            let spawnCalls = 0
            ;(engine as any).rpcGateway.spawnSession = async () => { spawnCalls += 1; return { type: 'error', message: 'unexpected' } }

            const result = await engine.reopenSession(session.id, 'default')
            expect(result).toMatchObject({ type: 'error', message: 'Pi resume requires an upgraded runner' })
            expect(spawnCalls).toBe(0)
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.lifecycleState).toBe('archived')
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('quarantines a Pi attempt when runner spawn fails before process termination is confirmed', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-spawn-error-live-child', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-spawn-error',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            }, null, 'default')
            engine.getOrCreateMachine('machine-1', { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' }, {
                status: 'running', capabilities: { piExistingSessionResume: true }
            }, 'default')
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })
            ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'error', message: 'webhook timeout' })
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({
                type: 'error', message: 'webhook timeout'
            })
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt?.state).toBe('quarantined')
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.lifecycleState).toBe('archived')
            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({
                type: 'error', message: 'Pi resume is already in progress'
            })
        } finally { engine.stop() }
    })

    it('keeps persisted Pi quarantine across SyncEngine restart and clears it on end', async () => {
        const store = new Store(':memory:')
        const first = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const persisted = first.getOrCreateSession('pi-persisted-attempt', {
            path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-persisted',
            lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
            piResumeAttempt: { state: 'quarantined', machineId: 'machine-1', startedAt: 1 },
        }, null, 'default')
        first.stop()

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            expect(await restarted.reopenSession(persisted.id, 'default')).toMatchObject({
                type: 'error', message: 'Pi resume is already in progress'
            })
            restarted.handleSessionEnd({ sid: persisted.id, time: Date.now(), reason: 'error' })
            await flushAsyncWork()
            expect(restarted.getSessionByNamespace(persisted.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { restarted.stop() }
    })

    it('clears a persisted Pi attempt when native-ready arrives after Hub restart', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-ready-after-restart', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-ready',
                piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            engine.handleSessionReady({ sid: session.id, time: Date.now() })
            await flushAsyncWork()
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('clears same-process Pi quarantine when a late validated ready arrives', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-late-ready', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-late-ready',
                piResumeAttempt: { state: 'quarantined', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            ;(engine as any).piResumeQuarantinedIds.add(session.id)
            engine.handleSessionReady({ sid: session.id, time: Date.now() })
            await flushAsyncWork()
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
            expect((engine as any).piResumeQuarantinedIds.has(session.id)).toBe(false)
        } finally { engine.stop() }
    })

    it('does not report active Pi attempts as reopened before validated ready', async () => {
        for (const state of ['resuming', 'terminating'] as const) {
            const store = new Store(':memory:')
            const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            try {
                const session = engine.getOrCreateSession(`pi-active-${state}`, {
                    path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: `pi-native-${state}`,
                    piResumeAttempt: { state, machineId: 'machine-1', startedAt: 1 },
                }, null, 'default')
                engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                expect(await engine.reopenSession(session.id, 'default')).toMatchObject({
                    type: 'error', message: 'Pi resume is already in progress'
                })
            } finally { engine.stop() }
        }
    })

    it('reconciles persisted quarantined Pi state when the runner reports the child already gone', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-stale-quarantine', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-stale-quarantine',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
                piResumeAttempt: { state: 'quarantined', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({
                type: 'error', message: 'Previous Pi resume attempt was cleaned up; retry'
            })
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('reconciles a persisted Pi attempt with an already-gone runner child without clearing archive state', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-stale-resume-attempt', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-stale',
                // Mirrors bootstrapExistingSession before native get_state: the
                // live metadata says running, while the attempt carries the
                // exact archived snapshot needed if the child is already gone.
                lifecycleState: 'running', lifecycleStateSince: 200,
                piResumeAttempt: {
                    state: 'resuming', machineId: 'machine-1', startedAt: 1,
                    archiveSnapshot: {
                        lifecycleState: 'archived', lifecycleStateSince: 100,
                        archivedBy: 'cli', archiveReason: 'Pi exited',
                    },
                },
            }, null, 'default')
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            expect(await engine.reopenSession(session.id, 'default')).toMatchObject({
                type: 'error', message: 'Previous Pi resume attempt was cleaned up; retry'
            })
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.lifecycleState).toBe('archived')
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.lifecycleStateSince).toBe(100)
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.archivedBy).toBe('cli')
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.archiveReason).toBe('Pi exited')
        } finally { engine.stop() }
    })

    it('does not quarantine an in-place Pi row when session-end wins the stop response race', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('pi-stop-end-race', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-race',
                piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            ;(engine as any).rpcGateway.stopRunnerSession = async () => {
                engine.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'error' })
                return 'still_alive'
            }

            expect(await (engine as any).terminateInPlacePiResume('machine-1', session.id, 'default', true)).toBe(true)
            await flushAsyncWork()
            expect(engine.getSessionByNamespace(session.id, 'default')?.active).toBe(false)
            expect(engine.getSessionByNamespace(session.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('does not persist an unexpected-child quarantine when child end wins the stop response race', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const original = engine.getOrCreateSession('pi-original-stop-race', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-race',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
                piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            const temp = engine.getOrCreateSession('pi-temp-stop-race', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi',
            }, null, 'default')
            engine.handleSessionAlive({ sid: temp.id, time: Date.now() })
            ;(engine as any).rpcGateway.stopRunnerSession = async () => {
                engine.handleSessionEnd({ sid: temp.id, time: Date.now(), reason: 'error' })
                return 'still_alive'
            }

            expect(await (engine as any).terminateUnexpectedPiTemp('machine-1', temp.id, original.id, 'default')).toBe(true)
            await flushAsyncWork()
            expect(store.sessions.getSession(temp.id)).toBeNull()
            expect(engine.getSessionByNamespace(original.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
        } finally { engine.stop() }
    })

    it('keeps still-alive Pi children quarantined even when Hub cache is inactive', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const original = engine.getOrCreateSession('pi-still-alive-inactive', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-still-alive',
                piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
            expect(await (engine as any).terminateInPlacePiResume('machine-1', original.id, 'default')).toBe(false)

            const temp = engine.getOrCreateSession('pi-temp-still-alive-inactive', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi',
            }, null, 'default')
            expect(await (engine as any).terminateUnexpectedPiTemp('machine-1', temp.id, original.id, 'default')).toBe(false)
            expect(store.sessions.getSession(temp.id)).not.toBeNull()
            expect(engine.getSessionByNamespace(original.id, 'default')?.metadata?.piResumeAttempt).toMatchObject({
                state: 'quarantined', childSessionId: temp.id
            })
        } finally { engine.stop() }
    })

    it('blocks dedup for a persisted unexpected Pi child and clears the original attempt on child end', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const temp = engine.getOrCreateSession('pi-temp-mapped', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-mapped',
            }, null, 'default')
            const original = engine.getOrCreateSession('pi-original-mapped', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-mapped',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
                piResumeAttempt: { state: 'quarantined', machineId: 'machine-1', startedAt: 1, childSessionId: temp.id },
            }, null, 'default')
            let dedupCalls = 0
            ;(engine as any).sessionCache.deduplicateByAgentSessionId = async () => { dedupCalls += 1 }
            ;(engine as any).triggerDedupIfNeeded(temp.id)
            await flushAsyncWork()
            expect(dedupCalls).toBe(0)
            expect(store.sessions.getSession(original.id)).not.toBeNull()

            engine.handleSessionEnd({ sid: temp.id, time: Date.now(), reason: 'error' })
            await flushAsyncWork()
            expect(engine.getSessionByNamespace(original.id, 'default')?.metadata?.piResumeAttempt).toBeUndefined()
            expect(store.sessions.getSession(original.id)).not.toBeNull()
            expect(dedupCalls).toBe(0)
        } finally { engine.stop() }
    })

    it('blocks Pi dedup before an unexpected child ID is attached to the persisted attempt', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const original = engine.getOrCreateSession('pi-original-pre-mapping', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-pre-mapping',
                lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'Pi exited',
                piResumeAttempt: { state: 'resuming', machineId: 'machine-1', startedAt: 1 },
            }, null, 'default')
            const temp = engine.getOrCreateSession('pi-temp-pre-mapping', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'pi', piSessionId: 'pi-native-pre-mapping',
            }, null, 'default')
            engine.handleSessionAlive({ sid: temp.id, time: Date.now() })
            let dedupCalls = 0
            ;(engine as any).sessionCache.deduplicateByAgentSessionId = async () => { dedupCalls += 1 }

            ;(engine as any).triggerDedupIfNeeded(temp.id)
            await flushAsyncWork()
            expect(dedupCalls).toBe(0)
            expect(store.sessions.getSession(original.id)).not.toBeNull()
        } finally { engine.stop() }
    })

    it('defers mergeSessions for cursor reopen until session-ready (load failure leaves old row)', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-reopen-old',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-fail',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            const spawnedSession = engine.getOrCreateSession(
                'cursor-reopen-spawned',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-fail',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            const spawnedSessionId = spawnedSession.id

            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }

            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: spawnedSessionId, time: Date.now() })
                return { type: 'success', sessionId: spawnedSessionId }
            }
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => ({ onDisk: true, store: 'acp' })
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ended'

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Session ended before Cursor ACP load completed',
                code: 'resume_failed'
            })
            expect(mergeCalls).toBe(0)
            expect(store.sessions.getSession(oldSession.id)).not.toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('does not dedup-merge when ACP spawn ends without session-ready', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-acp-dedup-old',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-dedup-fail',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            const spawnedSession = engine.getOrCreateSession(
                'cursor-acp-dedup-spawned',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-dedup-fail',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )

            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }

            engine.handleSessionAlive({ sid: spawnedSession.id, time: Date.now() })
            engine.handleSessionEnd({ sid: spawnedSession.id, time: Date.now(), reason: 'error' })

            expect(mergeCalls).toBe(0)
            expect(store.sessions.getSession(oldSession.id)).not.toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('mergeSessions runs for cursor reopen after session-ready', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-reopen-old-ready',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-ok',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            const spawnedSession = engine.getOrCreateSession(
                'cursor-reopen-spawned-ready',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-csid-load-ok',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            const spawnedSessionId = spawnedSession.id

            let mergeCalls = 0
            const sessionCache = (engine as any).sessionCache
            const mergeSessions = sessionCache.mergeSessions.bind(sessionCache)
            sessionCache.mergeSessions = async (oldSessionId: string, newSessionId: string, namespace: string) => {
                mergeCalls += 1
                return mergeSessions(oldSessionId, newSessionId, namespace)
            }

            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: spawnedSessionId, time: Date.now() })
                engine.handleSessionReady({ sid: spawnedSessionId, time: Date.now() })
                return { type: 'success', sessionId: spawnedSessionId }
            }
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => ({ onDisk: true, store: 'acp' })
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: spawnedSessionId })
            expect(mergeCalls).toBe(1)
            expect(store.sessions.getSession(oldSession.id)).toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('does not wait for session-ready on cursor stream-json reopen', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const oldSession = engine.getOrCreateSession(
                'cursor-legacy-reopen-old',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'legacy-csid',
                    cursorSessionProtocol: 'stream-json'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
            engine.handleSessionEnd({ sid: oldSession.id, time: Date.now() })

            const spawnedSession = engine.getOrCreateSession(
                'cursor-legacy-reopen-spawned',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor',
                    cursorSessionId: 'legacy-csid',
                    cursorSessionProtocol: 'stream-json'
                },
                null,
                'default'
            )
            const spawnedSessionId = spawnedSession.id

            let waitForSessionReadyCalls = 0
            ;(engine as any).waitForSessionReady = async () => {
                waitForSessionReadyCalls += 1
                return 'timeout'
            }
            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: spawnedSessionId, time: Date.now() })
                return { type: 'success', sessionId: spawnedSessionId }
            }
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => ({ onDisk: true, store: 'legacy' })
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(oldSession.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: spawnedSessionId })
            expect(waitForSessionReadyCalls).toBe(0)
        } finally {
            engine.stop()
        }
    })

    it('resolves a local resume target for a Codex session', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-codex',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                { controlledByUser: false },
                'default',
                'gpt-5.4',
                undefined,
                'xhigh'
            )

            const result = engine.resolveLocalResumeTarget(session.id, 'default')

            expect(result).toEqual({
                type: 'success',
                target: {
                    sessionId: session.id,
                    flavor: 'codex',
                    directory: '/tmp/project',
                    machineId: 'machine-1',
                    host: 'localhost',
                    active: session.active,
                    thinking: session.thinking,
                    controlledByUser: false,
                    agentSessionId: 'codex-thread-1',
                    model: 'gpt-5.4',
                    effort: null,
                    modelReasoningEffort: 'xhigh',
                    permissionMode: undefined,
                    collaborationMode: undefined
                }
            })
        } finally {
            engine.stop()
        }
    })

    it('resolves a local resume target for a Grok session', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-grok',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'grok',
                    grokSessionId: 'grok-session-1'
                },
                { controlledByUser: false },
                'default',
                'grok-4.5',
                'low'
            )

            const result = engine.resolveLocalResumeTarget(session.id, 'default')

            expect(result.type).toBe('success')
            if (result.type === 'success') {
                expect(result.target).toMatchObject({
                    flavor: 'grok',
                    agentSessionId: 'grok-session-1',
                    model: 'grok-4.5',
                    effort: 'low'
                })
            }
        } finally {
            engine.stop()
        }
    })

    it('recovers a Claude local resume target from stored messages', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-claude-from-message',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude'
                },
                null,
                'default'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        sessionId: '22222222-2222-4222-8222-222222222222'
                    }
                }
            })

            const result = engine.resolveLocalResumeTarget(session.id, 'default')

            expect(result.type).toBe('success')
            if (result.type === 'success') {
                expect(result.target.flavor).toBe('claude')
                expect(result.target.agentSessionId).toBe('22222222-2222-4222-8222-222222222222')
            }
        } finally {
            engine.stop()
        }
    })

    it('returns resume_unavailable when the local resume target lacks an agent session id', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-no-agent-id',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex'
                },
                null,
                'default'
            )

            expect(engine.resolveLocalResumeTarget(session.id, 'default')).toEqual({
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            })
        } finally {
            engine.stop()
        }
    })

    it('returns resume_unavailable when a cursor session lacks cursorSessionId', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-cursor-no-id',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor'
                },
                null,
                'default'
            )

            expect(engine.resolveLocalResumeTarget(session.id, 'default')).toEqual({
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            })
        } finally {
            engine.stop()
        }
    })

    it('refuses Cursor resume before spawning when the recorded chat store is missing', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'cursor-missing-store',
                {
                    path: '/tmp/project',
                    host: 'cursor-host',
                    machineId: 'cursor-machine',
                    homeDir: '/home/cursor-owner',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-thread-missing',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'cursor-machine',
                { host: 'cursor-host', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'cursor-machine', time: Date.now() })

            let spawnCalled = false
            let probeArgs: unknown[] | null = null
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async (...args: unknown[]) => {
                probeArgs = args
                return { onDisk: false, store: null }
            }
            ;(engine as any).rpcGateway.spawnSession = async () => {
                spawnCalled = true
                return { type: 'success', sessionId: session.id }
            }

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Cursor chat data is no longer available on the recorded machine',
                code: 'resume_unavailable'
            })
            expect(probeArgs as unknown).toEqual([
                'cursor-machine',
                '/tmp/project',
                'cursor-thread-missing',
                '/home/cursor-owner'
            ])
            expect(spawnCalled).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('probes Cursor chat data on the session recorded machine', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'cursor-machine-scoped-store',
                {
                    path: '/remote/project',
                    host: 'shared-host-label',
                    machineId: 'recorded-machine',
                    homeDir: '/home/recorded-owner',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-thread-remote',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            for (const machineId of ['other-machine', 'recorded-machine']) {
                engine.getOrCreateMachine(
                    machineId,
                    { host: 'shared-host-label', platform: 'linux', happyCliVersion: '0.1.0' },
                    null,
                    'default'
                )
                engine.handleMachineAlive({ machineId, time: Date.now() })
            }

            let captured: unknown[] | null = null
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async (...args: unknown[]) => {
                captured = args
                return { onDisk: true, store: 'acp' }
            }

            const result = await engine.getCursorChatStoreStatus(session.id, 'default')

            expect(result).toEqual({
                type: 'success',
                status: { onDisk: true, store: 'acp' }
            })
            expect(captured as unknown).toEqual([
                'recorded-machine',
                '/remote/project',
                'cursor-thread-remote',
                '/home/recorded-owner'
            ])
        } finally {
            engine.stop()
        }
    })

    it('does not probe a same-host machine when the recorded Cursor machine is offline', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'cursor-offline-recorded-machine-status',
                {
                    path: '/remote/project',
                    host: 'shared-host-label',
                    machineId: 'recorded-machine-offline',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-thread-offline',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'recorded-machine-offline',
                { host: 'shared-host-label', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'wrong-same-host-machine',
                { host: 'shared-host-label', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'wrong-same-host-machine', time: Date.now() })

            let probeCalled = false
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => {
                probeCalled = true
                return { onDisk: true, store: 'acp' }
            }

            expect(await engine.getCursorChatStoreStatus(session.id, 'default')).toEqual({
                type: 'error',
                message: 'No machine online',
                code: 'no_machine_online'
            })
            expect(probeCalled).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('does not probe or spawn on a same-host machine when the recorded Cursor machine is offline', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'cursor-offline-recorded-machine-resume',
                {
                    path: '/remote/project',
                    host: 'shared-host-label',
                    machineId: 'recorded-machine-offline',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-thread-offline',
                    cursorSessionProtocol: 'acp'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'recorded-machine-offline',
                { host: 'shared-host-label', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'wrong-same-host-machine',
                { host: 'shared-host-label', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'wrong-same-host-machine', time: Date.now() })

            let probeCalled = false
            let spawnCalled = false
            ;(engine as any).rpcGateway.getCursorChatStoreStatus = async () => {
                probeCalled = true
                return { onDisk: true, store: 'acp' }
            }
            ;(engine as any).rpcGateway.spawnSession = async () => {
                spawnCalled = true
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            expect(await engine.resumeSession(session.id, 'default')).toEqual({
                type: 'error',
                message: 'No machine online',
                code: 'no_machine_online'
            })
            expect(probeCalled).toBe(false)
            expect(spawnCalled).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('resumeSession fresh-spawns when inactive cursor session has no agent id and no user messages', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'never-started-cursor',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'cursor'
                },
                null,
                'default'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedResumeSessionId: string | undefined = 'unset'
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                resumeSessionId?: string
            ) => {
                capturedResumeSessionId = resumeSessionId
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedResumeSessionId).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('includes first user message in local resumable sessions', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-first-message',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1',
                    name: 'Generated title'
                },
                null,
                'default'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: 'text', text: 'agent warmup' }
            })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: '  Build the picker\nwith search  ' }
            })

            const sessions = engine.listLocalResumableSessions('default', { machineId: 'machine-1' })

            expect(sessions.find((item) => item.sessionId === session.id)).toMatchObject({
                name: 'Generated title',
                firstUserMessage: 'Build the picker with search'
            })
        } finally {
            engine.stop()
        }
    })

    it('recovers first user message from stored Claude user output events', () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-resume-first-claude-output',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: '11111111-1111-4111-8111-111111111111',
                    name: 'Generated title'
                },
                null,
                'default'
            )
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{ type: 'text', text: 'First Claude prompt' }]
                        }
                    }
                }
            })

            const sessions = engine.listLocalResumableSessions('default', { machineId: 'machine-1' })

            expect(sessions.find((item) => item.sessionId === session.id)).toMatchObject({
                name: 'Generated title',
                firstUserMessage: 'First Claude prompt'
            })
        } finally {
            engine.stop()
        }
    })

    it('local handoff succeeds immediately for inactive sessions', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-handoff-inactive',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                { controlledByUser: false },
                'default'
            )
            engine.handleSessionEnd({ sid: session.id, time: Date.now() })

            await expect(engine.handoffSessionToLocal(session.id, 'default')).resolves.toEqual({
                type: 'success'
            })
        } finally {
            engine.stop()
        }
    })

    it('local handoff rejects sessions already controlled by a local terminal', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'local-handoff-already-local',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                { controlledByUser: true },
                'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'local' })

            await expect(engine.handoffSessionToLocal(session.id, 'default')).resolves.toEqual({
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            })
        } finally {
            engine.stop()
        }
    })

    describe('session dedup by agent session ID', () => {
        it('merges duplicate when codexSessionId collides', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            // Add a message to s1
            store.messages.addMessage(s1.id, { type: 'text', text: 'hello from s1' }, 'local-1')

            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            expect(s1.id).not.toBe(s2.id)

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeUndefined()
            expect(cache.getSession(s2.id)).toBeDefined()

            const messages = store.messages.getMessages(s2.id, 100)
            expect(messages.length).toBeGreaterThanOrEqual(1)
        })

        it('merges duplicate when copilotSessionId collides', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'copilot-tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'copilot', copilotSessionId: 'copilot-thread-X' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'copilot-tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'copilot', copilotSessionId: 'copilot-thread-X' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeUndefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('preserves sessions with different agent session IDs', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-Y' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('does not merge across namespaces', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'ns1'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'ns2'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })

        it('no-op when session has no agent session ID', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s1.id)

            expect(cache.getSession(s1.id)).toBeDefined()
        })

        it('does not move history while duplicate sessions are both active', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: { 'req-from-active-duplicate': { tool: 'Bash', arguments: {} } },
                    completedRequests: {}
                },
                'default'
            )

            store.messages.addMessage(s1.id, { type: 'text', text: 'history from s1' }, 'local-s1')
            cache.handleSessionAlive({ sid: s1.id, time: Date.now(), thinking: false })

            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: { 'req-from-target': { tool: 'Read', arguments: {} } },
                    completedRequests: {}
                },
                'default'
            )
            store.messages.addMessage(s2.id, { type: 'text', text: 'history from s2' }, 'local-s2')
            cache.handleSessionAlive({ sid: s2.id, time: Date.now() + 1000, thinking: false })

            await cache.deduplicateByAgentSessionId(s2.id)

            // Both live session records keep their own histories until one of the
            // duplicates becomes inactive. The web may still be showing either
            // active session id, so the hub must not pick a canonical target yet.
            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
            expect(store.messages.getMessages(s1.id, 100).map((message) => (message.content as { text?: string }).text)).toEqual([
                'history from s1'
            ])
            expect(store.messages.getMessages(s2.id, 100).map((message) => (message.content as { text?: string }).text)).toEqual([
                'history from s2'
            ])
            expect(events.some((event) => event.type === 'messages-invalidated')).toBe(false)

            const sourceRequests = cache.getSession(s1.id)?.agentState?.requests ?? {}
            const targetRequests = cache.getSession(s2.id)?.agentState?.requests ?? {}
            expect(sourceRequests['req-from-active-duplicate']).toBeDefined()
            expect(targetRequests['req-from-active-duplicate']).toBeUndefined()
            expect(targetRequests['req-from-target']).toBeDefined()
        })

        it('invalidates both sessions for history-only merges', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                {
                    requests: { 'req-from-source': { tool: 'Bash', arguments: {} } },
                    completedRequests: {}
                },
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                {
                    requests: { 'req-from-target': { tool: 'Read', arguments: {} } },
                    completedRequests: {}
                },
                'default'
            )

            store.messages.addMessage(s1.id, { type: 'text', text: 'history from s1' }, 'local-s1')
            store.messages.addMessage(s2.id, { type: 'text', text: 'history from s2' }, 'local-s2')

            await cache.mergeSessionHistory(s1.id, s2.id, 'default', { mergeAgentState: false })

            expect(store.messages.getMessages(s1.id, 100)).toHaveLength(0)
            expect(store.messages.getMessages(s2.id, 100).map((message) => (message.content as { text?: string }).text)).toEqual([
                'history from s1',
                'history from s2'
            ])
            expect(events).toContainEqual({ type: 'messages-invalidated', sessionId: s1.id, namespace: 'default' })
            expect(events).toContainEqual({ type: 'messages-invalidated', sessionId: s2.id, namespace: 'default' })

            const sourceRequests = cache.getSession(s1.id)?.agentState?.requests ?? {}
            const targetRequests = cache.getSession(s2.id)?.agentState?.requests ?? {}
            expect(sourceRequests['req-from-source']).toBeDefined()
            expect(targetRequests['req-from-source']).toBeUndefined()
            expect(targetRequests['req-from-target']).toBeDefined()
        })

        it('merges duplicate after it becomes inactive via session-end', async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )

            try {
                const s1 = engine.getOrCreateSession(
                    'tag-1',
                    { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                    null,
                    'default'
                )
                const s2 = engine.getOrCreateSession(
                    'tag-2',
                    { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                    null,
                    'default'
                )

                // Mark s1 as active
                engine.handleSessionAlive({ sid: s1.id, time: Date.now() })

                // s1 is active, so dedup keeps its live record around
                const events: SyncEvent[] = []
                const cache = (engine as any).sessionCache as SessionCache
                await cache.deduplicateByAgentSessionId(s2.id)
                expect(cache.getSession(s1.id)).toBeDefined()

                // Now s1 ends — handleSessionEnd should trigger dedup retry
                engine.handleSessionEnd({ sid: s1.id, time: Date.now() })

                // Give the fire-and-forget dedup a tick to complete
                await new Promise((r) => setTimeout(r, 50))

                // One of them should be merged away
                const s1Exists = cache.getSession(s1.id)
                const s2Exists = cache.getSession(s2.id)
                expect(!s1Exists || !s2Exists).toBe(true)
            } finally {
                engine.stop()
            }
        })

        it('merges duplicate after inactivity timeout expires it', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                null,
                'default'
            )

            // Mark both duplicates active. The older live record should keep
            // existing while active, because its socket may still send keepalives.
            const now = Date.now()
            cache.handleSessionAlive({ sid: s1.id, time: now })
            cache.handleSessionAlive({ sid: s2.id, time: now })

            // s1 is active — dedup only moves history and keeps the record.
            await cache.deduplicateByAgentSessionId(s2.id)
            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()

            // Simulate only s1 passing beyond the 30s timeout.
            cache.getSession(s1.id)!.activeAt = now - 31_000
            const expired = cache.expireInactive(now)
            expect(expired).toContain(s1.id)
            expect(expired).not.toContain(s2.id)

            // Now s1 is inactive — dedup should merge it
            await cache.deduplicateByAgentSessionId(s2.id)
            // Exactly one session should survive after dedup; which one is the
            // target depends on activeAt/updatedAt ordering, which can vary by
            // millisecond timing in CI.
            const remaining = [cache.getSession(s1.id), cache.getSession(s2.id)].filter(Boolean)
            expect(remaining).toHaveLength(1)
        })

        it('deep-merges agentState and filters completed requests', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: {
                        'req-1': { tool: 'Bash', arguments: {} },
                        'req-2': { tool: 'Bash', arguments: {} }
                    },
                    completedRequests: {}
                },
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-X' },
                {
                    requests: {
                        'req-3': { tool: 'Bash', arguments: {} }
                    },
                    completedRequests: {
                        'req-1': { tool: 'Bash', arguments: {}, status: 'approved' }
                    }
                },
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            const session = cache.getSession(s2.id)
            expect(session).toBeDefined()
            const state = session!.agentState!

            // req-1 was completed in s2 — should NOT appear in requests
            expect(state.requests?.['req-1']).toBeUndefined()
            // req-2 and req-3 are still pending
            expect(state.requests?.['req-2']).toBeDefined()
            expect(state.requests?.['req-3']).toBeDefined()
            // completedRequests has req-1
            expect(state.completedRequests?.['req-1']).toBeDefined()
        })

        it('merges duplicate when piSessionId collides', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-sess-A' },
                null,
                'default'
            )

            store.messages.addMessage(s1.id, { type: 'text', text: 'hello from s1' }, 'local-1')

            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-sess-A' },
                null,
                'default'
            )

            expect(s1.id).not.toBe(s2.id)

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeUndefined()
            expect(cache.getSession(s2.id)).toBeDefined()

            const messages = store.messages.getMessages(s2.id, 100)
            expect(messages.length).toBeGreaterThanOrEqual(1)
        })

        it('preserves sessions with different piSessionId', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const s1 = cache.getOrCreateSession(
                'tag-1',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-A' },
                null,
                'default'
            )
            const s2 = cache.getOrCreateSession(
                'tag-2',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-B' },
                null,
                'default'
            )

            await cache.deduplicateByAgentSessionId(s2.id)

            expect(cache.getSession(s1.id)).toBeDefined()
            expect(cache.getSession(s2.id)).toBeDefined()
        })
    })

    describe('clearSessionArchiveMetadata', () => {
        it('clears lifecycleState/archivedBy/archiveReason from an archived session', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-archived',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'thread-X',
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                },
                null,
                'default'
            )

            const result = await cache.clearSessionArchiveMetadata(session.id)

            expect(result.cursorSessionProtocol).toBeUndefined()
            const updated = cache.getSession(session.id)
            const meta = updated?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBeUndefined()
            expect(meta?.archivedBy).toBeUndefined()
            expect(meta?.archiveReason).toBeUndefined()
            expect(typeof meta?.lifecycleStateSince).toBe('number')
        })

        it('defaults cursorSessionProtocol to stream-json for pre-#799 cursor sessions', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-cursor-legacy',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'cursor',
                    cursorSessionId: 'legacy-cursor-id',
                    lifecycleState: 'archived'
                },
                null,
                'default'
            )

            const result = await cache.clearSessionArchiveMetadata(session.id)

            expect(result.cursorSessionProtocol).toBe('stream-json')
            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.cursorSessionProtocol).toBe('stream-json')
        })

        it('keeps an existing acp protocol intact when clearing archive metadata', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-cursor-acp',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'cursor',
                    cursorSessionId: 'acp-cursor-id',
                    cursorSessionProtocol: 'acp',
                    lifecycleState: 'archived'
                },
                null,
                'default'
            )

            const result = await cache.clearSessionArchiveMetadata(session.id)

            expect(result.cursorSessionProtocol).toBe('acp')
            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.cursorSessionProtocol).toBe('acp')
            expect(meta?.lifecycleState).toBeUndefined()
        })

        it('does not stamp cursorSessionProtocol when no cursorSessionId is present', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-cursor-fresh',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'cursor',
                    lifecycleState: 'archived'
                },
                null,
                'default'
            )

            const result = await cache.clearSessionArchiveMetadata(session.id)

            expect(result.cursorSessionProtocol).toBeUndefined()
            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.cursorSessionProtocol).toBeUndefined()
        })

        it('throws when the session id is unknown', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            await expect(cache.clearSessionArchiveMetadata('missing-session')).rejects.toThrow('Session not found')
        })
    })

    describe('reopenSession rollback', () => {
        it('restores archive metadata when resumeSession fails after the clear', async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )

            try {
                const session = engine.getOrCreateSession(
                    'session-reopen-rollback',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1',
                        lifecycleState: 'archived',
                        archivedBy: 'cli',
                        archiveReason: 'Session crashed',
                        lifecycleStateSince: 1000
                    },
                    null,
                    'default'
                )
                // No machine registered -> resumeSession returns no_machine_online.

                const result = await engine.reopenSession(session.id, 'default')

                expect(result.type).toBe('error')
                if (result.type === 'error') {
                    expect(result.code).toBe('no_machine_online')
                }

                const restored = engine.getSessionByNamespace(session.id, 'default')?.metadata as Record<string, unknown> | null | undefined
                expect(restored?.lifecycleState).toBe('archived')
                expect(restored?.archivedBy).toBe('cli')
                expect(restored?.archiveReason).toBe('Session crashed')
            } finally {
                engine.stop()
            }
        })

        it('does not roll back when resumeSession succeeds', async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(
                store,
                {} as never,
                new RpcRegistry(),
                { broadcast() {} } as never
            )

            try {
                const session = engine.getOrCreateSession(
                    'session-reopen-success',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-2',
                        lifecycleState: 'archived',
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    },
                    null,
                    'default'
                )
                engine.getOrCreateMachine(
                    'machine-1',
                    { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                    null,
                    'default'
                )
                engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

                ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'success', sessionId: session.id })
                ;(engine as any).waitForSessionActive = async () => true

                const result = await engine.reopenSession(session.id, 'default')

                expect(result.type).toBe('success')
                if (result.type === 'success') {
                    expect(result.resumed).toBe(true)
                }

                const after = engine.getSessionByNamespace(session.id, 'default')?.metadata as Record<string, unknown> | null | undefined
                expect(after?.lifecycleState).toBeUndefined()
                expect(after?.archivedBy).toBeUndefined()
                expect(after?.archiveReason).toBeUndefined()
            } finally {
                engine.stop()
            }
        })
    })

    describe('restoreSessionArchiveMetadata', () => {
        it('puts back lifecycleState/archivedBy/archiveReason from a snapshot', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-restore',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'thread-Y',
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                    lifecycleStateSince: 1234567890
                },
                null,
                'default'
            )

            await cache.clearSessionArchiveMetadata(session.id)
            const cleared = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(cleared?.lifecycleState).toBeUndefined()

            await cache.restoreSessionArchiveMetadata(session.id, {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated',
                lifecycleStateSince: 1234567890
            })

            const restored = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(restored?.lifecycleState).toBe('archived')
            expect(restored?.archivedBy).toBe('cli')
            expect(restored?.archiveReason).toBe('User terminated')
            expect(restored?.lifecycleStateSince).toBe(1234567890)
        })

        it('deletes archive fields that were absent in the snapshot for an exact restore', async () => {
            // Covers the legacy case: an archived session that predates `lifecycleStateSince`.
            // `clearSessionArchiveMetadata` stamps a fresh `lifecycleStateSince`; if reopen
            // then fails, the restore must drop that stamp so the row's lifecycle age does
            // not appear to be "just now" to UI / import code.
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-restore-partial',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'thread-Z',
                    lifecycleState: 'archived',
                    archiveReason: 'Session crashed'
                    // no archivedBy, no lifecycleStateSince
                },
                null,
                'default'
            )

            await cache.clearSessionArchiveMetadata(session.id)
            // lifecycleStateSince was just stamped fresh by the clear; verify it's set so
            // the next assertion proves the restore actively deleted it.
            const cleared = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(typeof cleared?.lifecycleStateSince).toBe('number')

            await cache.restoreSessionArchiveMetadata(session.id, {
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
                // archivedBy + lifecycleStateSince intentionally absent from snapshot
            })

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBe('archived')
            expect(meta?.archiveReason).toBe('Session crashed')
            expect(meta?.archivedBy).toBeUndefined()
            expect(meta?.lifecycleStateSince).toBeUndefined()
        })

        it('is a no-op when the session is gone', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            await expect(cache.restoreSessionArchiveMetadata('missing', {
                lifecycleState: 'archived'
            })).resolves.toBeUndefined()
        })
    })

    // tiann/hapi#916: when the CLI is gone, the kill-RPC throws
    // RpcTargetMissingError. markSessionArchivedFromHub writes the archive
    // metadata directly so the row's lifecycleState still flips to 'archived'.
    describe('markSessionArchivedFromHub (tiann/hapi#916)', () => {
        it('flips lifecycleState to archived with archivedBy=hub and the supplied reason', () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-hub-archive',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-1' },
                null,
                'default'
            )

            const updatedAtBeforeArchive = store.sessions.getSession(session.id)?.updatedAt
            cache.markSessionArchivedFromHub(session.id, 'Archived from hub (CLI unreachable)')

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(store.sessions.getSession(session.id)?.updatedAt).toBe(updatedAtBeforeArchive)
            expect(meta?.lifecycleState).toBe('archived')
            expect(meta?.archivedBy).toBe('hub')
            expect(meta?.archiveReason).toBe('Archived from hub (CLI unreachable)')
            expect(typeof meta?.lifecycleStateSince).toBe('number')
        })

        it('is idempotent for already-archived sessions (does not reset lifecycleStateSince)', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const initialSince = 1700000000000
            const session = cache.getOrCreateSession(
                'session-already-archived',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                    lifecycleStateSince: initialSince
                },
                null,
                'default'
            )

            cache.markSessionArchivedFromHub(session.id, 'Should not overwrite')

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBe('archived')
            expect(meta?.archivedBy).toBe('cli')
            expect(meta?.archiveReason).toBe('User terminated')
            expect(meta?.lifecycleStateSince).toBe(initialSince)
        })

        it('self-heals on version-mismatch via refresh-and-retry', () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-hub-archive-stale',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            const dbSession = store.sessions.getSessionByNamespace(session.id, 'default')!
            const oobWrite = store.sessions.updateSessionMetadata(
                session.id,
                { ...dbSession.metadata!, name: 'oob' },
                dbSession.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            expect(oobWrite.result).toBe('success')

            cache.markSessionArchivedFromHub(session.id, 'CLI unreachable')

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBe('archived')
            expect(meta?.archivedBy).toBe('hub')
            expect(meta?.name).toBe('oob')
        })

        // tiann/hapi#916 review feedback: persistence failures must surface
        // so the /archive route returns 5xx per the acceptance criteria
        // "Non-RPC errors during archive still propagate as 5xx (DB write
        // failure, etc.)" — silent return would let the route claim success
        // while the row stays unarchived.
        it('throws when the store reports a hard error on the metadata write', () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-hub-archive-error',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            const updateSpy = spyOn(store.sessions, 'updateSessionMetadata').mockReturnValue({
                result: 'error',
                error: new Error('simulated DB write failure')
            } as ReturnType<typeof store.sessions.updateSessionMetadata>)

            try {
                expect(() => cache.markSessionArchivedFromHub(session.id, 'CLI unreachable')).toThrow(/Failed to archive session metadata from hub/)
            } finally {
                updateSpy.mockRestore()
            }
        })

        it('throws when retries are exhausted by sustained version-mismatch contention', () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-hub-archive-exhausted',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            const updateSpy = spyOn(store.sessions, 'updateSessionMetadata').mockReturnValue({
                result: 'version-mismatch'
            } as ReturnType<typeof store.sessions.updateSessionMetadata>)

            try {
                expect(() => cache.markSessionArchivedFromHub(session.id, 'CLI unreachable')).toThrow(/Session was modified concurrently while archiving from hub/)
            } finally {
                updateSpy.mockRestore()
            }
        })
    })

    // tiann/hapi#919: the three metadata writers must self-heal on
    // version-mismatch instead of one-shot-throwing. The bug was that a
    // stale cache snapshot produced forever-409 on the corresponding HTTP
    // endpoints — the cache never refreshed, so the same retry hit the
    // same mismatch. Pattern mirrors mergeSessions (line ~780).
    describe('version-mismatch self-heal (tiann/hapi#919)', () => {
        it('renameSession recovers after a stale cache snapshot is detected', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-rename-stale',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                null,
                'default'
            )

            // Simulate a concurrent writer bumping the DB version under our feet:
            // write a metadata patch out-of-band via the store, leaving the cache
            // snapshot stale.
            const dbSession = store.sessions.getSessionByNamespace(session.id, 'default')!
            const oobWrite = store.sessions.updateSessionMetadata(
                session.id,
                { ...dbSession.metadata!, name: 'concurrent-rename' },
                dbSession.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            expect(oobWrite.result).toBe('success')

            // Cache still holds the pre-OOB snapshot. Pre-fix, this call threw
            // 'Session was modified concurrently'. Post-fix, it refreshes and
            // succeeds.
            await expect(cache.renameSession(session.id, 'final-name')).resolves.toBeUndefined()

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.name).toBe('final-name')
        })

        it('clearSessionArchiveMetadata recovers after a stale cache snapshot', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-clear-stale',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'thread-stale',
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                },
                null,
                'default'
            )

            // Concurrent rename via the store bumps the DB version.
            const dbSession = store.sessions.getSessionByNamespace(session.id, 'default')!
            const oobWrite = store.sessions.updateSessionMetadata(
                session.id,
                { ...dbSession.metadata!, name: 'oob-name' },
                dbSession.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            expect(oobWrite.result).toBe('success')

            await expect(cache.clearSessionArchiveMetadata(session.id)).resolves.toBeDefined()

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBeUndefined()
            expect(meta?.archivedBy).toBeUndefined()
            expect(meta?.name).toBe('oob-name')
        })

        it('restoreSessionArchiveMetadata recovers after a stale cache snapshot', async () => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))

            const session = cache.getOrCreateSession(
                'session-restore-stale',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'thread-restore-stale'
                    // Started without archive metadata - simulates the post-clear state.
                },
                null,
                'default'
            )

            // Concurrent unrelated write bumps DB version.
            const dbSession = store.sessions.getSessionByNamespace(session.id, 'default')!
            const oobWrite = store.sessions.updateSessionMetadata(
                session.id,
                { ...dbSession.metadata!, name: 'parallel-rename' },
                dbSession.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            expect(oobWrite.result).toBe('success')

            await expect(cache.restoreSessionArchiveMetadata(session.id, {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated',
                lifecycleStateSince: 1234
            })).resolves.toBeUndefined()

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
            expect(meta?.lifecycleState).toBe('archived')
            expect(meta?.archiveReason).toBe('User terminated')
            expect(meta?.lifecycleStateSince).toBe(1234)
            expect(meta?.name).toBe('parallel-rename')
        })
    })
})
