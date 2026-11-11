import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function setup() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('tag-a', { path: '/tmp/a', host: 'mac' }, null, 'default')
    return { store, session }
}

describe('TurnStore', () => {
    it('opens and closes turns, never ending before the start', () => {
        const { store, session } = setup()
        try {
            expect(store.turns.open(session.id, 'default', 1_000, 'hub_prompt')).toBe(true)
            expect(store.turns.close(session.id, 500, 'idle')).toBe(true)
            expect(store.turns.close(session.id, 9_000, 'idle')).toBe(false)

            const [turn] = store.turns.list('default', 0, 10_000)
            expect(turn).toMatchObject({ sessionId: session.id, startedAt: 1_000, endedAt: 1_000, endReason: 'idle', trigger: 'hub_prompt' })
        } finally {
            store.close()
        }
    })

    it('lists turns overlapping the window, open ones included', () => {
        const { store, session } = setup()
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            store.turns.close(session.id, 2_000, 'idle')
            store.turns.open(session.id, 'default', 5_000, 'agent')

            expect(store.turns.list('default', 1_500, 1_600).map((turn) => turn.startedAt)).toEqual([1_000])
            expect(store.turns.list('default', 2_000, 4_000)).toEqual([])
            expect(store.turns.list('default', 9_000, 10_000).map((turn) => turn.endedAt)).toEqual([null])
            expect(store.turns.list('other', 0, 10_000)).toEqual([])
        } finally {
            store.close()
        }
    })

    it('ends turns left open by a restart at the session\'s newest message', () => {
        const { store, session } = setup()
        const idle = store.sessions.getOrCreateSession('tag-b', { path: '/tmp/b', host: 'mac' }, null, 'default')
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'working' } })
            store.turns.open(idle.id, 'default', 1_000, 'agent')

            const now = Date.now()
            expect(store.turns.closeDangling(now + 60_000, 10 * 60_000).sort()).toEqual([session.id, idle.id].sort())
            const turns = store.turns.list('default', 0, now + 120_000)
            const withMessage = turns.find((turn) => turn.sessionId === session.id)
            const withoutMessage = turns.find((turn) => turn.sessionId === idle.id)
            expect(withMessage?.endReason).toBe('hub_restart')
            expect(withMessage?.endedAt).toBeGreaterThanOrEqual(now - 5_000)
            expect(withMessage?.endedAt).toBeLessThanOrEqual(now + 5_000)
            // No message to go by: a zero-length turn rather than one running to now.
            expect(withoutMessage?.endedAt).toBe(1_000)
        } finally {
            store.close()
        }
    })

    it('lets an interrupted turn continue until a deadline counted from the restart', () => {
        const { store, session } = setup()
        const minute = 60_000
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            // No message for an hour before the restart: the turn ends long before it.
            const restart = 60 * minute
            store.turns.closeDangling(restart, 10 * minute)
            expect(store.turns.list('default', 0, restart)[0]?.endedAt).toBe(1_000)

            expect(store.turns.resumeInterrupted(session.id, restart + 11 * minute)).toBe(false)
            expect(store.turns.resumeInterrupted(session.id, restart + 5 * minute)).toBe(true)
            expect(store.turns.list('default', 0, restart)[0]?.endedAt).toBeNull()
            // Once resumed, it's an ordinary turn again.
            store.turns.close(session.id, restart + 6 * minute, 'idle')
            expect(store.turns.resumeInterrupted(session.id, restart + 7 * minute)).toBe(false)
        } finally {
            store.close()
        }
    })

    it('never continues a turn whose recovery was given up, or a turn that ended normally', () => {
        const { store, session } = setup()
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            store.turns.closeDangling(2_000, 10 * 60_000)
            store.turns.abandonRecovery(session.id)
            expect(store.turns.resumeInterrupted(session.id, 3_000)).toBe(false)

            store.turns.open(session.id, 'default', 4_000, 'agent')
            store.turns.close(session.id, 5_000, 'idle')
            expect(store.turns.resumeInterrupted(session.id, 5_500)).toBe(false)
        } finally {
            store.close()
        }
    })

    it('moves turns to the session that replaces it', () => {
        const { store, session } = setup()
        const replacement = store.sessions.getOrCreateSession('tag-c', { path: '/tmp/a', host: 'mac' }, null, 'default')
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            store.turns.close(session.id, 2_000, 'idle')
            store.turns.open(session.id, 'default', 3_000, 'agent')
            store.turns.open(replacement.id, 'default', 4_000, 'agent')

            store.turns.transferSession(session.id, replacement.id, 5_000)
            const turns = store.turns.list('default', 0, 10_000)
            expect(turns.every((turn) => turn.sessionId === replacement.id)).toBe(true)
            expect(turns.filter((turn) => turn.endedAt === null).map((turn) => turn.startedAt)).toEqual([4_000])
            expect(turns.find((turn) => turn.startedAt === 3_000)?.endedAt).toBe(5_000)
        } finally {
            store.close()
        }
    })

    it('goes away with its session', () => {
        const { store, session } = setup()
        try {
            store.turns.open(session.id, 'default', 1_000, 'agent')
            store.sessions.deleteSession(session.id, 'default')
            expect(store.turns.list('default', 0, 10_000)).toEqual([])
        } finally {
            store.close()
        }
    })
})
