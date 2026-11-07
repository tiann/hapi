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
    return { backend, handler, request: (request: PermissionRequest) => onRequest!(request) }
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
            onUserWait: (req) => {
                waits.push(`start ${req.id}`)
                return () => waits.push(`end ${req.id}`)
            }
        })

        request(commandRequest)
        await handler.cancelAll('Prompt finished')
        await handler.cancelAll('Prompt finished')

        expect(waits).toEqual(['start perm-1', 'end perm-1'])

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
