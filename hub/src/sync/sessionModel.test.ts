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

    it('reports session activity when CLI receives a turn-ready event over socket', () => {
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
                    type: 'event',
                    data: { type: 'ready' }
                }
            })
        })

        expect(activity).toHaveLength(1)
        expect(activity[0].sessionId).toBe(session.id)
        expect(activity[0].updatedAt).toBe(store.messages.getMessages(session.id, 1)[0]?.createdAt)
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

            cache.markSessionArchivedFromHub(session.id, 'Archived from hub (CLI unreachable)')

            const meta = cache.getSession(session.id)?.metadata as Record<string, unknown> | null | undefined
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
