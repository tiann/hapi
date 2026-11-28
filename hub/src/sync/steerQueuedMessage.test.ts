import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsFile, updateSettings } from '../config/settings'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcGateway } from './rpcGateway'

function createEngine() {
    const store = new Store(':memory:')
    const io = {
        of: () => ({
            to: () => ({ emit: () => {} })
        })
    }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('composer follow-up delivery', () => {
    it('uses the Hub default, preserves one-shot and legacy queue, and steers a duplicate only once', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-follow-up-'))
        const { store, engine } = createEngine()
        engine.setSettingsDataDirForTests(dataDir)
        const session = engine.getOrCreateSession(
            'composer-follow-up',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { followUpSteerTurnId: 'turn-1' },
            'default'
        )
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
        const otherSession = engine.getOrCreateSession(
            'other-composer-session',
            { path: '/tmp/other-project', host: 'localhost', flavor: 'claude' },
            { followUpSteerTurnId: 'other-turn' },
            'tenant'
        )
        engine.handleSessionAlive({ sid: otherSession.id, time: Date.now(), thinking: true })
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockImplementation(async (sid, localId) => {
            expect(store.messages.lookupQueuedMessage(sid, localId).status).toBe('queued')
            return { steered: true }
        })
        try {
            await engine.sendMessage(session.id, { text: 'unobserved turn', localId: 'stock', followUpIntent: 'default' })
            expect(steer).not.toHaveBeenCalled()
            await engine.sendMessage(session.id, { text: 'steer on purpose', localId: 'override', expectedFollowUpTurnId: 'turn-1', followUpIntent: 'steer' })
            expect(steer).toHaveBeenCalledWith(session.id, 'override', 'turn-1')
            steer.mockClear()
            await engine.sendMessage(session.id, { text: 'other mode', localId: 'opposite', followUpIntent: 'alternate', expectedFollowUpTurnId: 'turn-1' })
            await engine.sendMessage(session.id, { text: 'queued on purpose', localId: 'queue', followUpIntent: 'queue', expectedFollowUpTurnId: 'turn-1' })
            await engine.sendMessage(session.id, { text: 'legacy client', localId: 'legacy' })
            await engine.sendMessage(session.id, { text: '/compact', localId: 'command', followUpIntent: 'default', expectedFollowUpTurnId: 'turn-1' })
            await engine.sendMessage(session.id, {
                text: 'correction for an ended turn', localId: 'stale-request',
                followUpIntent: 'default', expectedFollowUpTurnId: 'turn-0'
            })
            expect(store.messages.lookupQueuedMessage(session.id, 'stale-request').status).toBe('queued')
            expect(steer).not.toHaveBeenCalled()

            const correction = { text: 'new direction', localId: 'same-id', expectedFollowUpTurnId: 'turn-1', followUpIntent: 'default' as const }
            await Promise.all([engine.sendMessage(session.id, correction), engine.sendMessage(session.id, correction)])
            expect(steer).toHaveBeenCalledTimes(1)
            expect(steer).toHaveBeenCalledWith(session.id, 'same-id', 'turn-1')
            await engine.sendMessage(otherSession.id, { ...correction, localId: 'other-stock', expectedFollowUpTurnId: 'other-turn' })
            expect(steer).toHaveBeenCalledWith(otherSession.id, 'other-stock', 'other-turn')
            await updateSettings(getSettingsFile(dataDir), current => ({
                settings: { ...current, followUpDefault: 'queue' }, result: undefined
            }))
            steer.mockClear()
            await engine.sendMessage(session.id, { ...correction, localId: 'configured-queue' })
            await engine.sendMessage(otherSession.id, { ...correction, localId: 'other-update', expectedFollowUpTurnId: 'other-turn' })
            expect(steer).not.toHaveBeenCalled()
            await engine.sendMessage(session.id, { ...correction, localId: 'opposite-steer', followUpIntent: 'alternate' })
            expect(steer).toHaveBeenCalledWith(session.id, 'opposite-steer', 'turn-1')
        } finally {
            steer.mockRestore()
            engine.stop()
            await rm(dataDir, { recursive: true, force: true })
        }
    })

    it.each(['same turn', 'new turn', 'cancelled', 'unknown', 'dispatching', 'consumed', 'disconnected', 'manual steer'] as const)(
        'reconsiders a blocked follow-up once after a decision: %s', async (outcome) => {
            const { store, engine } = createEngine()
            const requests = { approval: { tool: 'Bash', arguments: {} } }
            const session = engine.getOrCreateSession(
                'decision', { path: '/tmp', host: 'localhost', flavor: 'codex' },
                { followUpSteerTurnId: 'A', requests }, 'default'
            )
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockResolvedValue({ steered: true })
            const localId = 'original'
            try {
                await engine.sendMessage(session.id, { text: 'correction', localId, followUpIntent: 'steer', expectedFollowUpTurnId: 'A' })
                expect(steer).not.toHaveBeenCalled()
                const row = store.messages.lookupQueuedMessage(session.id, localId)
                expect(row.status).toBe('queued')
                if (row.status !== 'queued') throw new Error('Missing queue row')
                if (outcome === 'cancelled') {
                    store.messages.deleteQueuedMessageById(session.id, row.resolvedId)
                    engine.handleRealtimeEvent({ type: 'message-cancelled', sessionId: session.id, messageId: row.resolvedId })
                    store.messages.addMessage(session.id, { text: 'a replacement' }, localId)
                } else if (outcome === 'unknown' || outcome === 'dispatching') {
                    store.messages.setMessagesDeliveryState(session.id, [localId], outcome === 'unknown' ? 'indeterminate' : 'dispatching')
                } else if (outcome === 'consumed') {
                    store.messages.markMessagesInvoked(session.id, [localId], Date.now())
                } else if (outcome === 'disconnected') {
                    engine.handleSessionEnd({ sid: session.id, time: Date.now() })
                    engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
                } else if (outcome === 'manual steer') {
                    steer.mockRejectedValueOnce(new Error('lost reply'))
                    await engine.steerQueuedMessage(session.id, row.resolvedId)
                    expect(steer).toHaveBeenCalledTimes(1)
                    steer.mockClear()
                }
                // A nonblocking native Codex question can coexist with normal work.
                const state = {
                    followUpSteerTurnId: outcome === 'new turn' ? 'B' : 'A',
                    requests: { optional: { tool: 'request_user_input', arguments: { isBlocking: false } } }
                }
                const updated = store.sessions.updateSessionAgentState(session.id, state, session.agentStateVersion, 'default')
                if (updated.result !== 'success') throw new Error('Could not update agent state')
                const data = { agentState: { version: updated.version, value: state } }
                engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data })
                engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data })
                expect(steer).toHaveBeenCalledTimes(outcome === 'same turn' ? 1 : 0)
                if (outcome === 'same turn') expect(steer).toHaveBeenCalledWith(session.id, localId, 'A')
                await Promise.resolve()
            } finally {
                steer.mockRestore()
                engine.stop()
                store.close()
            }
        }
    )

    it('queues with an older runner and rejects a stale guarded steer', async () => {
        const { store, engine } = createEngine()
        const session = engine.getOrCreateSession(
            'composer-no-steer',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default'
        )
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockResolvedValue({ steered: true })
        try {
            await engine.sendMessage(session.id, { text: 'correction', localId: 'one', followUpIntent: 'steer' })
            expect(store.messages.lookupQueuedMessage(session.id, 'one').status).toBe('queued')
            expect(await engine.steerQueuedMessage(session.id, 'one', 'ended-turn'))
                .toMatchObject({ status: 'failed', error: 'Active turn changed' })
            expect(steer).not.toHaveBeenCalled()
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })
})

describe('SyncEngine.steerQueuedMessage', () => {
    it.each(['negative reply', 'lost reply'] as const)('returns the consumed row when a %s races native acceptance', async (outcome) => {
        const { store, engine } = createEngine()
        const session = engine.getOrCreateSession(
            'steer-racing-acceptance',
            { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
            { requests: {}, completedRequests: {} }, 'default'
        )
        const message = store.messages.addMessage(session.id, { text: 'correction' }, 'accepted-local')
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockImplementation(async () => {
            store.messages.markMessagesInvoked(session.id, ['accepted-local'], 2_000)
            if (outcome === 'lost reply') throw new Error('operation has timed out')
            return { steered: false, error: 'Message not in queue' }
        })
        try {
            expect(await engine.steerQueuedMessage(session.id, message.id)).toMatchObject({
                status: 'invoked', message: { id: message.id, localId: 'accepted-local', invokedAt: 2_000 }
            })
            expect(steer).toHaveBeenCalledTimes(1)
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it.each(['opencode', 'claude'] as const)('routes a remote %s correction using its original localId', async (flavor) => {
        const { store, engine } = createEngine()
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockResolvedValue({ steered: true })
        try {
            const session = engine.getOrCreateSession(
                `steer-${flavor}`,
                { path: '/tmp/project', host: 'localhost', flavor },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'correction' }, 'original-local')

            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({
                status: 'steered', localId: 'original-local'
            })
            expect(steer).toHaveBeenCalledWith(session.id, 'original-local')
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it.each(['queued', 'dispatching', 'indeterminate'] as const)('does not infer invocation from a failed RPC while the row is %s', async (state) => {
        const { store, engine } = createEngine()
        const session = engine.getOrCreateSession(
            'steer-unconfirmed',
            { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
            { requests: {}, completedRequests: {} }, 'default'
        )
        const message = store.messages.addMessage(session.id, { text: 'correction' }, 'unconfirmed-local')
        store.messages.setMessagesDeliveryState(session.id, ['unconfirmed-local'], state)
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockRejectedValue(new Error('operation has timed out'))
        try {
            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({
                status: 'failed', error: 'operation has timed out', localId: 'unconfirmed-local'
            })
            expect(store.messages.lookupQueuedMessage(session.id, message.id).status).not.toBe('invoked')
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it('returns the persisted invoked row on a repeated OpenCode steer', async () => {
        const { store, engine } = createEngine()
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage')
        try {
            const session = engine.getOrCreateSession(
                'steer-opencode-invoked',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'correction' }, 'original-local')
            store.messages.markMessagesInvoked(session.id, ['original-local'], 2_000)

            expect(await engine.steerQueuedMessage(session.id, 'original-local')).toMatchObject({
                status: 'invoked', message: { id: message.id, localId: 'original-local', invokedAt: 2_000 }
            })
            expect(steer).not.toHaveBeenCalled()
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it('rejects a locally controlled OpenCode session before invoking the CLI', async () => {
        const { store, engine } = createEngine()
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage')
        try {
            const session = engine.getOrCreateSession(
                'steer-opencode-local',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
                { requests: {}, completedRequests: {}, controlledByUser: true },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'correction' }, 'original-local')

            expect(await engine.steerQueuedMessage(session.id, message.id)).toEqual({
                status: 'failed', error: 'Steering is only available for remote sessions', localId: null
            })
            expect(steer).not.toHaveBeenCalled()
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it('rejects every scheduled row, mature ones included, without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-scheduled',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            // A mature scheduled row: the fire time already passed, but the row
            // is still uninvoked and waiting for the scheduled-FIFO release.
            const message = store.messages.addMessage(
                session.id,
                { text: 'mature scheduled' },
                'mature-local',
                Date.now() - 1_000
            )

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Scheduled messages cannot be steered',
                localId: 'mature-local'
            })
            // The row must stay queued — untouched by the rejected steer.
            const lookup = store.messages.lookupQueuedMessage(session.id, message.id)
            expect(lookup.status).toBe('queued')
        } finally {
            engine.stop()
        }
    })

    it('tells an Antigravity session without agy acp that Steer is not available yet', async () => {
        const { store, engine } = createEngine()
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockResolvedValue({ steered: true })
        try {
            const session = engine.getOrCreateSession(
                'steer-agy-starting',
                { path: '/tmp/project', host: 'localhost', flavor: 'agy' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'hi' }, 'local-id')

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Antigravity is not running on agy acp (yet); Steer is not available',
                localId: null
            })
            expect(steer).not.toHaveBeenCalled()
        } finally {
            steer.mockRestore()
            engine.stop()
        }
    })

    it('rejects unsupported flavors without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-gemini',
                { path: '/tmp/project', host: 'localhost', flavor: 'gemini' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'hi' }, 'local-id')

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Steering is only supported for Claude, Pi, Codex, OpenCode, Antigravity, and Cursor ACP sessions',
                localId: null
            })
        } finally {
            engine.stop()
        }
    })
})
