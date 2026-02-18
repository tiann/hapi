import { describe, expect, it } from 'bun:test'

import { Store } from './index'

describe('Store sessions/machines/messages', () => {
    it('returns version-mismatch payloads for stale session and machine updates', () => {
        const store = new Store(':memory:')

        const session = store.sessions.getOrCreateSession('session-tag', { path: '/repo' }, null, 'alpha')
        const sessionUpdated = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/repo', name: 'fresh' },
            session.metadataVersion,
            'alpha'
        )
        expect(sessionUpdated.result).toBe('success')
        if (sessionUpdated.result !== 'success') {
            throw new Error('Expected initial session update to succeed')
        }

        const staleSessionUpdate = store.sessions.updateSessionMetadata(
            session.id,
            { path: '/repo', name: 'stale' },
            session.metadataVersion,
            'alpha'
        )
        expect(staleSessionUpdate.result).toBe('version-mismatch')
        if (staleSessionUpdate.result !== 'version-mismatch') {
            throw new Error('Expected session version mismatch')
        }
        expect(staleSessionUpdate.version).toBe(sessionUpdated.version)
        expect(staleSessionUpdate.value).toEqual({ path: '/repo', name: 'fresh' })

        const machine = store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, { status: 'idle' }, 'alpha')
        const machineUpdated = store.machines.updateMachineRunnerState(
            machine.id,
            { status: 'running' },
            machine.runnerStateVersion,
            'alpha'
        )
        expect(machineUpdated.result).toBe('success')
        if (machineUpdated.result !== 'success') {
            throw new Error('Expected initial machine update to succeed')
        }

        const staleMachineUpdate = store.machines.updateMachineRunnerState(
            machine.id,
            { status: 'stale' },
            machine.runnerStateVersion,
            'alpha'
        )
        expect(staleMachineUpdate.result).toBe('version-mismatch')
        if (staleMachineUpdate.result !== 'version-mismatch') {
            throw new Error('Expected machine version mismatch')
        }
        expect(staleMachineUpdate.version).toBe(machineUpdated.version)
        expect(staleMachineUpdate.value).toEqual({ status: 'running' })
    })

    it('isolates sessions and machines by namespace', () => {
        const store = new Store(':memory:')

        const alphaSession = store.sessions.getOrCreateSession('shared-tag', { path: '/alpha' }, null, 'alpha')
        const betaSession = store.sessions.getOrCreateSession('shared-tag', { path: '/beta' }, null, 'beta')

        expect(alphaSession.id).not.toBe(betaSession.id)
        expect(store.sessions.getSessionByNamespace(alphaSession.id, 'alpha')?.id).toBe(alphaSession.id)
        expect(store.sessions.getSessionByNamespace(alphaSession.id, 'beta')).toBeNull()

        const alphaSessions = store.sessions.getSessionsByNamespace('alpha').map((session) => session.id)
        expect(alphaSessions).toContain(alphaSession.id)
        expect(alphaSessions).not.toContain(betaSession.id)

        const wrongNamespaceUpdate = store.sessions.updateSessionMetadata(
            alphaSession.id,
            { path: '/alpha', name: 'blocked' },
            alphaSession.metadataVersion,
            'beta'
        )
        expect(wrongNamespaceUpdate.result).toBe('error')

        const alphaMachine = store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'alpha')
        store.machines.getOrCreateMachine('machine-2', { host: 'beta' }, null, 'beta')
        expect(() => store.machines.getOrCreateMachine('machine-1', { host: 'beta' }, null, 'beta')).toThrow(
            'Machine namespace mismatch'
        )

        const alphaMachines = store.machines.getMachinesByNamespace('alpha').map((machine) => machine.id)
        expect(alphaMachines).toContain(alphaMachine.id)
        expect(alphaMachines).not.toContain('machine-2')
    })

    it('guards todos updates by timestamp', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todos-tag', { path: '/repo' }, null, 'alpha')

        const firstTimestamp = 1_000
        const staleTimestamp = 900
        const sameTimestamp = 1_000
        const newerTimestamp = 1_100

        expect(store.sessions.setSessionTodos(session.id, [{ id: 'first' }], firstTimestamp, 'alpha')).toBe(true)
        const afterFirst = store.sessions.getSession(session.id)
        if (!afterFirst) {
            throw new Error('Session missing after initial todos update')
        }

        expect(store.sessions.setSessionTodos(session.id, [{ id: 'stale' }], staleTimestamp, 'alpha')).toBe(false)
        expect(store.sessions.setSessionTodos(session.id, [{ id: 'same' }], sameTimestamp, 'alpha')).toBe(false)

        const unchanged = store.sessions.getSession(session.id)
        if (!unchanged) {
            throw new Error('Session missing after stale todos update')
        }
        expect(unchanged.todos).toEqual([{ id: 'first' }])
        expect(unchanged.todosUpdatedAt).toBe(firstTimestamp)
        expect(unchanged.seq).toBe(afterFirst.seq)

        expect(store.sessions.setSessionTodos(session.id, [{ id: 'newer' }], newerTimestamp, 'alpha')).toBe(true)

        const latest = store.sessions.getSession(session.id)
        if (!latest) {
            throw new Error('Session missing after latest todos update')
        }
        expect(latest.todos).toEqual([{ id: 'newer' }])
        expect(latest.todosUpdatedAt).toBe(newerTimestamp)
        expect(latest.seq).toBe(afterFirst.seq + 1)
    })

    it('deduplicates message localId and clamps list limits', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('message-tag', { path: '/repo' }, null, 'alpha')

        const first = store.messages.addMessage(session.id, { body: 'first' }, 'local-1')
        const duplicate = store.messages.addMessage(session.id, { body: 'changed' }, 'local-1')

        expect(duplicate.id).toBe(first.id)
        expect(duplicate.seq).toBe(first.seq)
        expect(duplicate.content).toEqual({ body: 'first' })

        for (let i = 0; i < 205; i += 1) {
            store.messages.addMessage(session.id, { idx: i })
        }

        const clampedMax = store.messages.getMessages(session.id, 999)
        expect(clampedMax).toHaveLength(200)
        expect(clampedMax[0]?.seq).toBe(7)
        expect(clampedMax[clampedMax.length - 1]?.seq).toBe(206)

        const clampedMin = store.messages.getMessages(session.id, 0)
        expect(clampedMin).toHaveLength(1)
        expect(clampedMin[0]?.seq).toBe(206)
    })

    it('merges session messages and nulls collided localIds', () => {
        const store = new Store(':memory:')
        const fromSession = store.sessions.getOrCreateSession('from-tag', { path: '/from' }, null, 'alpha')
        const toSession = store.sessions.getOrCreateSession('to-tag', { path: '/to' }, null, 'alpha')

        store.messages.addMessage(toSession.id, { label: 'to-collide' }, 'same-local-id')
        store.messages.addMessage(toSession.id, { label: 'to-unique' }, 'to-only')
        store.messages.addMessage(fromSession.id, { label: 'from-collide' }, 'same-local-id')
        store.messages.addMessage(fromSession.id, { label: 'from-unique' }, 'from-only')

        const merge = store.messages.mergeSessionMessages(fromSession.id, toSession.id)
        expect(merge).toEqual({ moved: 2, oldMaxSeq: 2, newMaxSeq: 2 })

        expect(store.messages.getMessages(fromSession.id, 50)).toHaveLength(0)

        const merged = store.messages.getMessages(toSession.id, 50)
        expect(merged.map((message) => message.seq)).toEqual([1, 2, 3, 4])

        const localIdByLabel = new Map(
            merged.map((message) => [
                (message.content as { label?: string })?.label,
                message.localId
            ])
        )

        expect(localIdByLabel.get('to-collide')).toBe('same-local-id')
        expect(localIdByLabel.get('from-collide')).toBeNull()
        expect(localIdByLabel.get('from-unique')).toBe('from-only')
    })
})
