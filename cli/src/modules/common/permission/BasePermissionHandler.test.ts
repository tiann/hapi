import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_REQUEST_NOT_FOUND_MESSAGE } from '@hapi/protocol/rpcMethods'
import type { AgentState } from '@/api/types'
import {
    BasePermissionHandler,
    resolveToolAutoApprovalDecision,
    type PermissionCompletion,
    type PermissionHandlerClient,
    type PendingPermissionRequest
} from './BasePermissionHandler'

describe('resolveToolAutoApprovalDecision skill_lookup', () => {
    it.each([
        'skill_lookup',
        'hapi_skill_lookup',
        'happy__skill_lookup',
        'mcp__hapi__skill_lookup'
    ])('auto-approves the exact read-only HAPI tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            toolName,
            'call-1'
        )).toBe('approved')
    })

    it('does not approve another tool solely from a skill-looking call id', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_tool',
            'skill_lookup-forged-id'
        )).toBeNull()
    })

    it('does not approve another tool whose name only contains skill_lookup', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'skill_lookup_write_file',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_skill_lookup',
            'call-2'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision ping_peer', () => {
    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })

    it('still auto-approves unrelated read tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Read', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'grep', 'call-2')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision spawn_peer', () => {
    it.each([
        'spawn_peer',
        'mcp__hapi__spawn_peer',
        'hapi_spawn_peer',
        'Spawn Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'spawn_peer',
        'mcp__hapi__spawn_peer',
        'hapi_spawn_peer',
        'Spawn Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision inspect_peer', () => {
    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision list_peers', () => {
    it.each([
        'list_peers',
        'hapi_list_peers',
        'happy__list_peers',
        'mcp__hapi__list_peers',
        'List Peer Sessions'
    ])('auto-approves the exact discovery tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it('does not approve another tool whose name only contains list_peers', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'list_peers_and_write',
            'call-1'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision session_job', () => {
    it.each([
        'session_job',
        'hapi_session_job',
        'mcp__hapi__session_job',
        'Session-Attached Job'
    ])('does not name-only auto-approve spoofable job tool %s', (toolName) => {
        // Bridge / --allowedTools own the approve path; global title allowlist must not.
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })
})

type TestResponse = { id: string; answers?: Record<string, string[]> }

class GatedPermissionHandler extends BasePermissionHandler<TestResponse, { ok: true }> {
    private releaseGate: (() => void) | null = null
    private readonly gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve
    })

    constructor(client: PermissionHandlerClient) {
        super(client)
    }

    register(id: string, toolName: string, input: unknown): void {
        this.addPendingRequest(id, toolName, input, {
            resolve: () => {},
            reject: () => {}
        })
    }

    release(): void {
        this.releaseGate?.()
    }

    protected async handlePermissionResponse(
        response: TestResponse,
        _pending: PendingPermissionRequest<{ ok: true }>
    ): Promise<PermissionCompletion> {
        await this.gate
        return {
            status: 'approved',
            decision: 'approved',
            answers: response.answers
        }
    }

    protected handleMissingPendingResponse(_response: TestResponse): void {
        throw new Error(PERMISSION_REQUEST_NOT_FOUND_MESSAGE)
    }
}

// tiann/hapi#2415: orphan cleanup must not cancel a request whose first answer
// is still awaiting handlePermissionResponse.
describe('BasePermissionHandler overlapping answers', () => {
    it('preserves the first answer completion when a second answer arrives mid-flight', async () => {
        let agentState: AgentState = { requests: {}, completedRequests: {} } as AgentState
        let rpcHandler: ((response: TestResponse) => Promise<void>) | undefined

        const client: PermissionHandlerClient = {
            rpcHandlerManager: {
                registerHandler: <TRequest = unknown, TResponse = unknown>(
                    _method: string,
                    handler: (params: TRequest) => TResponse | Promise<TResponse>
                ) => {
                    rpcHandler = handler as unknown as (response: TestResponse) => Promise<void>
                }
            },
            updateAgentState: (fn) => {
                agentState = fn(agentState)
            }
        }

        const handler = new GatedPermissionHandler(client)
        handler.register('req-1', 'AskUserQuestion', { questions: [] })
        expect(agentState.requests?.['req-1']).toBeDefined()

        const first = rpcHandler!({
            id: 'req-1',
            answers: { '0': ['keep-me'] }
        })
        // First answer deleted pending and is parked in handlePermissionResponse.
        await Promise.resolve()

        await expect(rpcHandler!({ id: 'req-1', answers: { '0': ['discard-me'] } })).rejects.toThrow(
            PERMISSION_REQUEST_NOT_FOUND_MESSAGE
        )
        // Overlapping answer must not cancel agentState out from under the first.
        expect(agentState.requests?.['req-1']).toBeDefined()
        expect(agentState.completedRequests?.['req-1']).toBeUndefined()

        handler.release()
        await first

        expect(agentState.requests?.['req-1']).toBeUndefined()
        expect(agentState.completedRequests?.['req-1']).toMatchObject({
            status: 'approved',
            decision: 'approved',
            answers: { '0': ['keep-me'] }
        })
    })
})
