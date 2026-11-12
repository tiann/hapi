import { describe, expect, it, vi } from 'vitest'
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

    it('records denied attachment path when an ACP read with absent rawInput is denied via RPC', async () => {
        let onRequest: ((request: PermissionRequest) => void) | null = null
        let rpcHandler: ((data: any) => Promise<any>) | null = null
        const markAttachmentDenied = vi.fn()
        const backend = {
            onPermissionRequest: vi.fn((h) => { onRequest = h }),
            respondToPermission: vi.fn(async () => {}),
            cancelPrompt: vi.fn(async () => {})
        }
        const client = {
            updateAgentState: vi.fn(),
            markAttachmentDenied,
            rpcHandlerManager: { registerHandler: vi.fn((_method, h) => { rpcHandler = h }) }
        }
        new AcpPermissionHandler(
            client as unknown as ApiSessionClient,
            backend as unknown as AgentBackend,
            () => 'default'
        )

        onRequest!({
            id: 'perm-acp-read-1',
            sessionId: 'acp-1',
            toolCallId: 'call_read_1',
            title: 'Read: private.txt',
            kind: 'read',
            rawInput: null,
            options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
        })

        // Simulate RPC denial
        await rpcHandler!({ id: 'perm-acp-read-1', approved: false, decision: 'denied' })
        expect(markAttachmentDenied).toHaveBeenCalledWith('private.txt')
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
