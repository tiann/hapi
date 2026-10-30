import { describe, expect, it, vi } from 'vitest'
import { AgentStateSchema, SessionSchema, type AgentStateRequest, type AgentStateCompletedRequest } from '@hapi/protocol/schemas'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { AgentBackend, PermissionRequest } from './types'

const transport = vi.hoisted(() => ({
    version: 0,
    snapshots: [] as Array<{ requests: Record<string, AgentStateRequest>; completedRequests: Record<string, AgentStateCompletedRequest> }>,
    debug: vi.fn()
}))

vi.mock('@/ui/logger', () => ({ logger: { debug: transport.debug } }))
vi.mock('socket.io-client', () => ({
    io: () => {
        const socket = {
            connected: true,
            on: () => socket,
            off: () => socket,
            emit: () => socket,
            connect: () => socket,
            disconnect: () => socket,
            timeout: () => ({ emitWithAck: async () => ({}) }),
            emitWithAck: async (event: string, payload: {
                expectedVersion: number
                agentState: unknown
            }) => {
                expect(event).toBe('update-state')
                expect(payload.expectedVersion).toBe(transport.version)
                // Model the JSON boundary and successful versioned storage ACK.
                const wire = JSON.parse(JSON.stringify(payload.agentState))
                transport.snapshots.push(wire)
                return JSON.parse(JSON.stringify({
                    result: 'success', version: ++transport.version, agentState: wire
                }))
            }
        }
        return Object.assign(socket, { volatile: socket })
    }
}))

import { ApiSessionClient } from '@/api/apiSession'
import { PermissionAdapter } from './permissionAdapter'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { CopilotPermissionHandler } from '@/copilot/utils/permissionHandler'
import { GrokPermissionHandler } from '@/grok/utils/permissionHandler'
import { OpencodePermissionHandler } from '@/opencode/utils/permissionHandler'

describe.each([
    PermissionAdapter, AcpPermissionHandler, CopilotPermissionHandler,
    GrokPermissionHandler, OpencodePermissionHandler
].map(Handler => ({ name: Handler.name, Handler })))('$name JSON permission state', ({ Handler }) => {

    it.each([
        { label: 'missing input auto-approval', rawInput: undefined, rawOutput: undefined, expected: null, autoApprove: true },
        { label: 'missing input', rawInput: undefined, rawOutput: undefined, expected: null },
        { label: 'missing input denial', rawInput: undefined, rawOutput: undefined, expected: null, decision: 'denied' },
        { label: 'missing input abort', rawInput: undefined, rawOutput: undefined, expected: null, decision: 'abort' },
        { label: 'explicit null', rawInput: null, rawOutput: { output: true }, expected: null },
        { label: 'input object', rawInput: { path: 'report.md' }, rawOutput: undefined, expected: { path: 'report.md' } },
        { label: 'output fallback', rawInput: undefined, rawOutput: { output: true }, expected: { output: true } },
        ...[false, 0, ''].map(value => ({ label: `falsy input ${JSON.stringify(value)}`, rawInput: value, rawOutput: 'fallback', expected: value }))
    ])('$label: retain three requests and complete each decision', async (testCase) => {
        const { rawInput, rawOutput, expected } = testCase
        const autoApprove = 'autoApprove' in testCase && testCase.autoApprove
        const decision = 'decision' in testCase ? testCase.decision : 'approved'
        transport.version = 0
        transport.snapshots = []
        transport.debug.mockClear()
        const client = new ApiSessionClient('isolated-repro-token', SessionSchema.parse({
            id: '11111111-1111-4111-8111-111111111111', namespace: 'repro',
            seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            metadata: null, metadataVersion: 0,
            agentState: { requests: {}, completedRequests: {} }, agentStateVersion: 0,
            thinking: true, thinkingAt: 1, todos: [], model: null,
            modelReasoningEffort: null, effort: null, serviceTier: null
        }))
        let emitPermission: ((request: PermissionRequest) => void) | undefined
        const respondToPermission = vi.fn<AgentBackend['respondToPermission']>(async () => {})
        const backend: AgentBackend = {
            async initialize() {},
            async newSession() { return 'repro' },
            async prompt() {},
            async cancelPrompt() {},
            async disconnect() {},
            respondToPermission,
            onPermissionRequest(handler) { emitPermission = handler }
        }
        new Handler(client, backend, () => 'default')
        const ids = ['first', 'second', 'third']
        try {
            for (const id of ids) {
                if (!emitPermission) throw new Error('Permission listener not registered')
                emitPermission({
                    id, sessionId: 'repro', toolCallId: id, title: autoApprove ? 'hapi_change_title' : 'Write', rawInput, rawOutput,
                    options: [
                        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
                    ]
                })
            }
            if (autoApprove) {
                await vi.waitFor(() => expect(respondToPermission).toHaveBeenCalledTimes(3))
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
            } else {
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                expect(respondToPermission).not.toHaveBeenCalled()
                const pending = transport.snapshots.at(-1)!
                const pendingParsed = AgentStateSchema.safeParse(pending)
                expect.soft(pendingParsed.success, 'pending state survives JSON').toBe(true)
                expect.soft(Object.keys(pending.requests), 'all requests remain visible').toEqual(ids)

                expect.soft(Object.values(pending.requests).map(request => request.arguments)).toEqual(ids.map(() => expected))

                // Each decision must leave the other requests pending.
                for (const id of ids) {
                    await client.rpcHandlerManager.handleRequest({
                        method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                        params: JSON.stringify({ id, approved: decision === 'approved' || (decision === 'abort' && id !== 'third'),
                            decision: decision === 'abort' && id !== 'third' ? 'approved' : decision })
                    })
                    expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                    expect.soft(Object.keys(transport.snapshots.at(-1)!.requests)).toEqual(ids.slice(ids.indexOf(id) + 1))
                    expect(respondToPermission.mock.calls.map(call => call[1].id)).toEqual(ids.slice(0, ids.indexOf(id) + 1))
                }
            }
            expect(respondToPermission.mock.calls.map(call => call[1].id)).toEqual(ids)
            for (const call of respondToPermission.mock.calls) {
                expect(call[2]).toEqual(decision === 'abort' && call[1].id === 'third'
                    ? { outcome: 'cancelled' }
                    : { outcome: 'selected', optionId: decision === 'denied' ? 'reject-once' : 'allow-once' })
            }
            const completed = transport.snapshots.at(-1)!
            const completedParsed = AgentStateSchema.safeParse(completed)
            expect.soft(completedParsed.success, 'completed state survives JSON').toBe(true)
            expect.soft(Object.keys(completed.completedRequests), 'all decisions retained').toEqual(ids)
            const invalidAcks = transport.debug.mock.calls.filter(call =>
                String(call[0]).includes('Ignoring invalid agentState value from ack')
            ).length
            expect(invalidAcks).toBe(0)
            expect(Object.values(completed.completedRequests).map(request => request.arguments)).toEqual(ids.map(() => expected))
            expect(transport.snapshots.every(snapshot => AgentStateSchema.safeParse(snapshot).success)).toBe(true)
        } finally {
            client.close()
        }
    })
})
