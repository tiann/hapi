import { describe, expect, it, spyOn } from 'bun:test'
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

    it('routes a remote OpenCode correction using its original localId', async () => {
        const { store, engine } = createEngine()
        const steer = spyOn(RpcGateway.prototype, 'steerQueuedMessage').mockResolvedValue({ steered: true })
        try {
            const session = engine.getOrCreateSession(
                'steer-opencode',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode' },
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

    it('rejects unsupported flavors without invoking the CLI', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession(
                'steer-claude',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const message = store.messages.addMessage(session.id, { text: 'hi' }, 'local-id')

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Steering is only supported for Pi, Codex, OpenCode, and Cursor ACP sessions',
                localId: null
            })
        } finally {
            engine.stop()
        }
    })
})
