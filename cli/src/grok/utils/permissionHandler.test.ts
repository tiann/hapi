import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState } from '@/api/types'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import { GrokPermissionHandler } from './permissionHandler'

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

function createHarness(mode: 'default' | 'auto' | 'plan' | 'bypassPermissions') {
    let state: AgentState = { requests: {}, completedRequests: {} }
    let backendHandler: ((request: PermissionRequest) => void) | null = null
    const responses: PermissionResponse[] = []
    const rpcHandlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
    const session = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (payload: unknown) => Promise<unknown> | unknown) {
                rpcHandlers.set(method, handler)
            }
        },
        updateAgentState(handler: (current: AgentState) => AgentState) {
            state = handler(state)
        }
    } as unknown as ApiSessionClient
    const backend: AgentBackend = {
        async initialize() {},
        async newSession() { return 'session-1' },
        async prompt() {},
        async cancelPrompt() {},
        async respondToPermission(_sessionId, _request, response) { responses.push(response) },
        onPermissionRequest(handler) { backendHandler = handler },
        async disconnect() {}
    }
    new GrokPermissionHandler(session, backend, () => mode)
    return {
        state: () => state,
        responses,
        rpcHandlers,
        emit(request: PermissionRequest) {
            if (!backendHandler) throw new Error('handler missing')
            backendHandler(request)
        }
    }
}

function request(): PermissionRequest {
    return {
        id: 'perm-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        title: 'Shell',
        rawInput: { command: 'pwd' },
        options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]
    }
}

async function flush(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

describe('GrokPermissionHandler', () => {
    it('queues default-mode requests for HAPI approval', () => {
        const harness = createHarness('default')
        harness.emit(request())
        expect(harness.responses).toEqual([])
        expect(harness.state().requests?.['perm-1']).toMatchObject({ tool: 'Shell' })
    })

    it('queues dangerous requests that Grok Auto leaves for user approval', () => {
        const harness = createHarness('auto')
        harness.emit(request())
        expect(harness.responses).toEqual([])
        expect(harness.state().requests?.['perm-1']).toMatchObject({ tool: 'Shell' })
    })

    it('auto-approves bypassPermissions with the advertised allow-always option', async () => {
        const harness = createHarness('bypassPermissions')
        harness.emit(request())
        await flush()
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'allow-always' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session'
        })
    })

    it('denies tool execution in plan mode', async () => {
        const harness = createHarness('plan')
        harness.emit(request())
        await flush()
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'reject-once' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'denied',
            decision: 'denied'
        })
    })
})
