import { describe, expect, it } from 'bun:test'
import {
    extractAgentOutputUserText,
    getExecutionControl,
    isCodexDesktopMirrorSession,
    isNonblankAgentOutputUserTurnStart,
} from './messages'
import {
    DeliveryAttemptStateSchema,
    ManagedLifecycleStateSchema,
    ManagedStopReasonSchema,
    MetadataSchema
} from './schemas'
import { ManagedSessionOutcomeRequestSchema } from './socket'

describe('managed runner lifecycle schemas', () => {
    it('accepts every managed lifecycle state', () => {
        for (const state of ['running', 'archived', 'stopped', 'unhealthy'] as const) {
            expect(ManagedLifecycleStateSchema.parse(state)).toBe(state)
        }
    })

    it('accepts every managed stop reason', () => {
        for (const reason of [
            'runner-recycle',
            'runner-recycle-sigkill',
            'stale-owner-term',
            'stale-owner-sigkill',
            'ambiguous-turn-delivery'
        ] as const) {
            expect(ManagedStopReasonSchema.parse(reason)).toBe(reason)
        }
    })

    it('keeps lifecycle timestamps as epoch milliseconds', () => {
        expect(MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            lifecycleState: 'unhealthy',
            lifecycleStateSince: 1_721_000_000_000,
            stopReasonCode: 'ambiguous-turn-delivery'
        }).lifecycleStateSince).toBe(1_721_000_000_000)

        expect(() => MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            lifecycleStateSince: '2026-07-14T00:00:00Z'
        })).toThrow()
    })

    it('accepts every append-only delivery attempt state', () => {
        for (const state of [
            'prepared',
            'written',
            'accepted',
            'definitive-rejected',
            'definitive-no-write',
            'ambiguous',
            'canceled',
            'superseded'
        ] as const) {
            expect(DeliveryAttemptStateSchema.parse(state)).toBe(state)
        }
    })

    it('requires active to agree with the managed lifecycle state', () => {
        const base = {
            namespace: 'default', machineId: 'machine-1', sessionId: 'session-1',
            launchNonce: 'launch-1', runnerInstanceId: 'runner-1', expectedVersion: 1,
            idempotencyKey: 'outcome-1', lifecycleStateSince: 1
        }
        expect(ManagedSessionOutcomeRequestSchema.safeParse({
            ...base, lifecycleState: 'running', active: true
        }).success).toBe(true)
        expect(ManagedSessionOutcomeRequestSchema.safeParse({
            ...base, lifecycleState: 'stopped', active: true
        }).success).toBe(false)
    })
})

describe('isCodexDesktopMirrorSession', () => {
    it('returns true when metadata is marked as a desktop mirror', () => {
        expect(isCodexDesktopMirrorSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                mirrorSource: 'codex-desktop-sync'
            }
        })).toBe(true)
    })

    it('returns true when recent messages contain a passive desktop sync marker', () => {
        expect(isCodexDesktopMirrorSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost'
            },
            messages: [
                {
                    localId: 'codex:thread-1:12:abc123',
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'mirrored from desktop' }
                    }
                }
            ]
        })).toBe(true)
    })

    it('returns false for ordinary native HAPI messages', () => {
        expect(isCodexDesktopMirrorSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost'
            },
            messages: [
                {
                    localId: 'web-1',
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'native hapi send' },
                        meta: { sentFrom: 'webapp' }
                    }
                }
            ]
        })).toBe(false)
    })

    it('returns false for native HAPI runner sessions even when passive Codex transcript messages are present', () => {
        expect(isCodexDesktopMirrorSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                startedFromRunner: true,
                startedBy: 'runner'
            },
            messages: [
                {
                    localId: 'codex:thread-1:12:abc123',
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'echo from codex transcript' } },
                        meta: { sentFrom: 'codex-desktop-sync' }
                    }
                }
            ]
        })).toBe(false)
    })
})

describe('agent output user turn boundaries', () => {
    const output = (text: string) => ({
        type: 'output',
        data: {
            type: 'user',
            isSidechain: false,
            message: { content: [{ type: 'text', text }] },
        },
    })

    it('shares nonblank Claude user-output semantics across Hub and Web', () => {
        expect(extractAgentOutputUserText(output('next prompt'))).toBe('next prompt')
        expect(isNonblankAgentOutputUserTurnStart(output('next prompt'))).toBe(true)
        expect(isNonblankAgentOutputUserTurnStart(output('  \n\t'))).toBe(false)
    })
})

it('reads persisted execution control from metadata', () => {
    expect(getExecutionControl({
        path: '/tmp/project',
        host: 'localhost',
        executionControl: {
            owner: 'hapi-runner',
            generation: 4,
            leaseExpiresAt: 500,
            runnerSessionId: 'session-runner',
            updatedAt: 400
        }
    })).toEqual({
        owner: 'hapi-runner',
        generation: 4,
        leaseExpiresAt: 500,
        runnerSessionId: 'session-runner',
        updatedAt: 400
    })
})
