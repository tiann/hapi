import { describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { AgentBackend, PermissionRequest } from '@/agent/types'
import type { ApiSessionClient } from '@/api/apiSession'
import type { PermissionMode } from '@hapi/protocol/types'
import { AcpPermissionHandler } from './AcpPermissionHandler'

function setup(mode: PermissionMode, options?: ConstructorParameters<typeof AcpPermissionHandler>[3]) {
    let onRequest: ((request: PermissionRequest) => void) | null = null
    const backend = {
        onPermissionRequest: vi.fn((handler: (request: PermissionRequest) => void) => { onRequest = handler }),
        respondToPermission: vi.fn(async () => {}),
        cancelPrompt: vi.fn(async () => {})
    }
    const client = {
        updateAgentState: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() }
    }
    new AcpPermissionHandler(
        client as unknown as ApiSessionClient,
        backend as unknown as AgentBackend,
        () => mode,
        options
    )
    return { backend, client, request: (request: PermissionRequest) => onRequest!(request) }
}

function setupWithHandler(mode: PermissionMode, options?: ConstructorParameters<typeof AcpPermissionHandler>[3]) {
    let onRequest: ((request: PermissionRequest) => void) | null = null
    const backend = {
        onPermissionRequest: vi.fn((h: (request: PermissionRequest) => void) => { onRequest = h }),
        respondToPermission: vi.fn(async () => {}),
        cancelPrompt: vi.fn(async () => {})
    }
    const client = {
        updateAgentState: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() }
    }
    const handler = new AcpPermissionHandler(
        client as unknown as ApiSessionClient,
        backend as unknown as AgentBackend,
        () => mode,
        options
    )
    return { backend, client, handler, request: (request: PermissionRequest) => onRequest!(request) }
}

const commandRequest: PermissionRequest = {
    id: 'perm-1',
    sessionId: 'acp-1',
    toolCallId: 'call_1',
    // agy titles a run_command request with the command line itself.
    title: 'grep -n think notes.md',
    kind: 'execute',
    rawInput: { CommandLine: 'grep -n think notes.md' },
    options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
}

describe('AcpPermissionHandler auto-approval rules', () => {
    it('auto-approves a tool name hint by default', async () => {
        const { backend, request } = setup('default')

        request(commandRequest)

        await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
            'acp-1',
            commandRequest,
            { outcome: 'selected', optionId: 'allow' }
        ))
    })

    it('asks the user when the agent disables the name and id hints', () => {
        const { backend, client, request } = setup('default', { autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] } })

        request(commandRequest)

        expect(backend.respondToPermission).not.toHaveBeenCalled()
        const update = client.updateAgentState.mock.calls[0]![0] as (state: object) => { requests: Record<string, unknown> }
        expect(update({}).requests['perm-1']).toMatchObject({ tool: 'grep -n think notes.md' })
    })

    it('still approves everything in an always-approve mode without hints', async () => {
        const { backend, request } = setup('always-proceed', { autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] } })

        request(commandRequest)

        await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
            'acp-1',
            commandRequest,
            { outcome: 'selected', optionId: 'allow' }
        ))
    })

    const offersAlways: PermissionRequest = {
        ...commandRequest,
        options: [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
    }

    it('grants an always-approve request for the session by default', async () => {
        const { backend, request } = setup('always-proceed')

        request(offersAlways)

        await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
            'acp-1', offersAlways, { outcome: 'selected', optionId: 'always' }
        ))
    })

    it('answers automatic approvals once when the agent asks for it', async () => {
        const { backend, request } = setup('always-proceed', { autoApproveOnce: true })

        request(offersAlways)

        await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
            'acp-1', offersAlways, { outcome: 'selected', optionId: 'once' }
        ))
    })

    it('reports how long a request waited for the user, and only those', async () => {
        const waits: string[] = []
        const { request, handler } = setupWithHandler('request-review', {
            autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] },
            onUserWait: () => {
                waits.push('start')
                return () => waits.push('end')
            }
        })

        request(commandRequest)
        await handler.cancelAll('Prompt finished')
        await handler.cancelAll('Prompt finished')

        expect(waits).toEqual(['start', 'end'])

        const auto = setupWithHandler('always-proceed', { onUserWait: () => { throw new Error('not a user wait') } })
        auto.request(commandRequest)
    })

    it('never auto-answers a request the agent marks as needing the user', () => {
        const { backend, client, request } = setup('always-proceed', { requiresUser: () => true })

        request(commandRequest)

        expect(backend.respondToPermission).not.toHaveBeenCalled()
        const update = client.updateAgentState.mock.calls[0]![0] as (state: object) => { requests: Record<string, unknown> }
        expect(update({}).requests['perm-1']).toBeDefined()
    })
})

describe('AcpPermissionHandler questions for the user', () => {
    const questionInput = { questions: [{ question: 'RED or BLUE?', header: null, options: [{ label: 'RED', description: null }], multiSelect: false }] }

    function answerQuestion(client: ReturnType<typeof setupWithHandler>['client'], response: Record<string, unknown>) {
        const register = client.rpcHandlerManager.registerHandler.mock.calls[0]!
        const permissionRpc = register[1] as (payload: unknown) => Promise<void>
        return permissionRpc(response)
    }

    it.each(['request-review', 'always-proceed', 'yolo', 'bypassPermissions'] as const)(
        'waits for the user in %s and returns their answers',
        async (mode) => {
            const waits: string[] = []
            const { client, handler, backend } = setupWithHandler(mode, {
                onUserWait: () => {
                    waits.push('start')
                    return () => waits.push('end')
                }
            })
            const answer = handler.askUser('call_q', 'AskUserQuestion', questionInput)
            expect(handler.hasPendingRequests()).toBe(true)
            const update = client.updateAgentState.mock.calls.at(-1)![0] as (state: object) => { requests: Record<string, { tool: string }> }
            expect(update({}).requests['call_q']).toMatchObject({ tool: 'AskUserQuestion', arguments: questionInput })

            await answerQuestion(client, { id: 'call_q', approved: true, answers: { '0': ['RED'] } })

            await expect(answer).resolves.toEqual({ decision: 'approved', answers: { '0': ['RED'] } })
            expect(handler.hasPendingRequests()).toBe(false)
            expect(backend.respondToPermission).not.toHaveBeenCalled()
            expect(waits).toEqual(['start', 'end'])
        }
    )

    it('reports a declined question, and cancels an open one when everything is cancelled', async () => {
        const { client, handler } = setupWithHandler('request-review')
        const declined = handler.askUser('call_a', 'AskUserQuestion', questionInput)
        await answerQuestion(client, { id: 'call_a', approved: false, decision: 'denied' })
        await expect(declined).resolves.toEqual({ decision: 'denied' })

        const open = handler.askUser('call_b', 'AskUserQuestion', questionInput)
        await handler.cancelAll('User aborted')
        await expect(open).resolves.toEqual({ decision: 'abort' })
        expect(handler.hasPendingRequests()).toBe(false)
    })

    it('cancels an open question even when replying to a permission request fails', async () => {
        const { backend, handler, request } = setupWithHandler('request-review', {
            autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] }
        })
        request(commandRequest)
        const open = handler.askUser('call_b', 'AskUserQuestion', questionInput)
        backend.respondToPermission.mockRejectedValueOnce(new Error('agy is gone'))

        await expect(handler.cancelAll('Antigravity stopped')).rejects.toThrow('agy is gone')
        await expect(open).resolves.toEqual({ decision: 'abort' })
    })
})

describe('AcpPermissionHandler session-scoped grants', () => {
    type RegisteredHandler = (params: unknown) => Promise<void>

    function createHarness() {
        const registered = new Map<string, RegisteredHandler>()
        const client = {
            rpcHandlerManager: {
                registerHandler: vi.fn((method: string, handler: RegisteredHandler) => {
                    registered.set(method, handler)
                })
            },
            updateAgentState: vi.fn((fn: (state: unknown) => unknown) => fn({}))
        }
        const backend = {
            onPermissionRequest: vi.fn(),
            respondToPermission: vi.fn(async () => {}),
            cancelPrompt: vi.fn(async () => {})
        }
        return { client, backend, registered }
    }

    async function permissionRpcRespond(harness: ReturnType<typeof createHarness>, payload: unknown): Promise<void> {
        const handler = harness.registered.get(RPC_METHODS.Permission)
        if (!handler) throw new Error('permission RPC handler was not registered')
        await handler(payload)
    }

    function berryRequest(): PermissionRequest {
        return {
            sessionId: 'berry-session-1',
            id: 'acp-req-1',
            toolCallId: 'call-1',
            kind: 'other',
            title: 'Run command',
            options: [
                { optionId: 'opt-always', kind: 'allow_always', name: 'Always allow' },
                { optionId: 'opt-once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' }
            ]
        }
    }

    async function answerSessionGrant(harness: ReturnType<typeof createHarness>) {
        const request = berryRequest()
        ;(harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: unknown) => void]> } })
            .mock.calls[0][0](request)
        await permissionRpcRespond(harness, {
            id: request.id,
            approved: true,
            decision: 'approved_for_session'
        })
        return request
    }

    it('maps approved_for_session to allow_always by default', async () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as unknown as ApiSessionClient,
            harness.backend as unknown as AgentBackend,
            () => undefined
        )
        const request = await answerSessionGrant(harness)

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'berry-session-1',
            request,
            { outcome: 'selected', optionId: 'opt-always' }
        )
    })

    it('maps approved_for_session to allow_once when sessionScopedPermissionGrants is set', async () => {
        // Berry persists allow_always answers STICKILY in tool-policy.json —
        // they outlive the session. A HAPI "allow for session" pick must
        // therefore map to allow_once for berry backends.
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as unknown as ApiSessionClient,
            harness.backend as unknown as AgentBackend,
            () => undefined,
            { sessionScopedPermissionGrants: true }
        )
        const request = await answerSessionGrant(harness)

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'berry-session-1',
            request,
            { outcome: 'selected', optionId: 'opt-once' }
        )
    })

    it('falls back to allow_always in session-scoped mode when allow_once is absent', async () => {
        const harness = createHarness()
        const handler = new AcpPermissionHandler(
            harness.client as unknown as ApiSessionClient,
            harness.backend as unknown as AgentBackend,
            () => undefined,
            { sessionScopedPermissionGrants: true }
        )
        const request = berryRequest()
        request.options = request.options.filter((option) => option.kind !== 'allow_once')
        ;(harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: unknown) => void]> } })
            .mock.calls[0][0](request)
        await permissionRpcRespond(harness, {
            id: request.id,
            approved: true,
            decision: 'approved_for_session'
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
            'berry-session-1',
            request,
            { outcome: 'selected', optionId: 'opt-always' }
        )
    })

    it('keeps plain approvals preferring allow_once in both modes', async () => {
        for (const options of [undefined, { sessionScopedPermissionGrants: true }] as const) {
            const harness = createHarness()
            const handler = new AcpPermissionHandler(
                harness.client as unknown as ApiSessionClient,
                harness.backend as unknown as AgentBackend,
                () => undefined,
                options
            )
            const request = berryRequest()
            ;(harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: unknown) => void]> } })
                .mock.calls[0][0](request)
            await permissionRpcRespond(harness, {
                id: request.id,
                approved: true,
                decision: 'approved'
            })

            expect(harness.backend.respondToPermission).toHaveBeenCalledWith(
                'berry-session-1',
                request,
                { outcome: 'selected', optionId: 'opt-once' }
            )
        }
    })
})
