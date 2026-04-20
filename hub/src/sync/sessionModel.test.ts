import { describe, expect, it } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
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
    })
})
