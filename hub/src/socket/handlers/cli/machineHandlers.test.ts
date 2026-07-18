import { describe, expect, it } from 'bun:test'
import { PROVIDER_CAPABILITIES } from '@hapi/protocol'
import { Store } from '../../../store'
import { registerMachineHandlers } from './machineHandlers'
import type { CliSocketWithData } from '../../socketTypes'

class FakeSocket {
    readonly data: Record<string, unknown> = { namespace: 'default' }
    readonly handshake = { auth: { machineId: 'machine-1' } }
    private readonly handlers = new Map<string, (...args: unknown[]) => void>()
    on(event: string, handler: (...args: unknown[]) => void): this { this.handlers.set(event, handler); return this }
    to(): { emit: () => boolean } { return { emit: () => true } }
    trigger(event: string, ...args: unknown[]): void { this.handlers.get(event)?.(...args) }
}

describe('machine managed lifecycle handlers', () => {
    it('authenticates machine outcomes, refreshes the cache event, and gates terminal group stops', () => {
        const store = new Store(':memory:')
        const machine = store.machines.getOrCreateMachine('machine-1', { host: 'h' }, null, 'default')
        const session = store.sessions.getOrCreateSession('managed-1', {
            path: '/tmp', host: 'h', machineId: 'machine-1',
            launchNonce: '11111111-1111-4111-8111-111111111111', runnerInstanceId: 'runner-1',
            lifecycleState: 'running'
        }, null, 'default')
        const socket = new FakeSocket()
        const events: unknown[] = []
        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveMachineAccess: () => ({ ok: true, value: machine }),
            emitAccessError: () => { throw new Error('unexpected access error') },
            onWebappEvent: (event) => events.push(event)
        })

        let outcome: unknown
        socket.trigger('runner-managed-session-outcome', {
            idempotencyKey: 'outcome-1', namespace: 'default', machineId: 'machine-1', sessionId: session.id,
            launchNonce: '11111111-1111-4111-8111-111111111111', runnerInstanceId: 'runner-1',
            expectedVersion: null, lifecycleState: 'stopped', active: false, lifecycleStateSince: Date.now(),
            stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle'
        }, (answer: unknown) => { outcome = answer })
        expect(outcome).toMatchObject({ result: 'success', canonicalSessionId: session.id })
        expect(events).toEqual([{ type: 'session-updated', sessionId: session.id }])

        let barrier: unknown
        socket.trigger('runner-managed-stop-barrier', {
            namespace: 'default', machineId: 'machine-1', sessionId: session.id,
            launchNonce: '11111111-1111-4111-8111-111111111111', runnerInstanceId: 'runner-1'
        }, (answer: unknown) => { barrier = answer })
        expect(barrier).toEqual({ eligible: true, reason: 'canonical-terminal-outcome' })
    })

    it('rejects a lifecycle request not bound to the authenticated machine', () => {
        const store = new Store(':memory:')
        const machine = store.machines.getOrCreateMachine('machine-1', { host: 'h' }, null, 'default')
        const socket = new FakeSocket()
        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveMachineAccess: () => ({ ok: true, value: machine }),
            emitAccessError: () => {}
        })
        let answer: unknown
        socket.trigger('runner-managed-stop-barrier', {
            namespace: 'default', machineId: 'machine-2', sessionId: 'missing',
            launchNonce: '11111111-1111-4111-8111-111111111111', runnerInstanceId: 'runner-1'
        }, (value: unknown) => { answer = value })
        expect(answer).toEqual({ eligible: false, reason: 'access-denied' })
    })

    it('rejects malformed machine metadata without mutating the versioned store', () => {
        const store = new Store(':memory:')
        const original = {
            host: 'runner.example',
            platform: 'darwin',
            happyCliVersion: '1.2.3'
        }
        const machine = store.machines.getOrCreateMachine('machine-1', original, null, 'default')
        const socket = new FakeSocket()
        const events: unknown[] = []
        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveMachineAccess: () => ({ ok: true, value: machine }),
            emitAccessError: () => {},
            onWebappEvent: (event) => events.push(event)
        })

        let answer: unknown
        socket.trigger('machine-update-metadata', {
            machineId: 'machine-1',
            expectedVersion: machine.metadataVersion,
            metadata: { ...original, unexpected: true }
        }, (value: unknown) => { answer = value })

        expect(answer).toEqual({ result: 'error', reason: 'invalid-request' })
        expect(store.machines.getMachine('machine-1')).toMatchObject({
            metadata: original,
            metadataVersion: machine.metadataVersion
        })
        expect(events).toEqual([])
    })

    it('accepts and persists a strict provider readiness snapshot', () => {
        const store = new Store(':memory:')
        const original = {
            host: 'runner.example',
            platform: 'darwin',
            happyCliVersion: '1.2.3'
        }
        const machine = store.machines.getOrCreateMachine('machine-1', original, null, 'default')
        const socket = new FakeSocket()
        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveMachineAccess: () => ({ ok: true, value: machine }),
            emitAccessError: () => {}
        })
        const metadata = {
            ...original,
            providerReadiness: {
                grok: {
                    status: 'ready' as const,
                    installed: true,
                    authenticated: true,
                    authCheck: 'credential-file' as const,
                    version: '0.2.101',
                    ...PROVIDER_CAPABILITIES.grok,
                    checkedAt: 1_800_000_000_000
                }
            }
        }

        let answer: unknown
        socket.trigger('machine-update-metadata', {
            machineId: 'machine-1',
            expectedVersion: machine.metadataVersion,
            metadata
        }, (value: unknown) => { answer = value })

        expect(answer).toMatchObject({ result: 'success', version: machine.metadataVersion + 1 })
        expect(store.machines.getMachine('machine-1')?.metadata).toEqual(metadata)
    })
})
