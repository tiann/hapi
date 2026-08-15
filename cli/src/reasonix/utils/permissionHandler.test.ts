import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState } from '@/api/types'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import { ReasonixPermissionHandler } from './permissionHandler'

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

function createHarness(
    options?: PermissionRequest['options'],
    cancelPrompt: (sessionId: string) => Promise<void> = async () => {}
) {
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
        async cancelPrompt(sessionId) {
            await cancelPrompt(sessionId)
        },
        async respondToPermission(_sessionId, _request, response) { responses.push(response) },
        onPermissionRequest(handler) { backendHandler = handler },
        async disconnect() {}
    }
    new ReasonixPermissionHandler(session, backend)
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

function request(options?: PermissionRequest['options']): PermissionRequest {
    return {
        id: 'perm-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        title: 'Shell',
        rawInput: { command: 'pwd' },
        options: options ?? [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]
    }
}

describe('ReasonixPermissionHandler', () => {
    it('keeps ACP permission requests behind HAPI approval', () => {
        const harness = createHarness()
        harness.emit(request())
        expect(harness.responses).toEqual([])
        expect(harness.state().requests?.['perm-1']).toMatchObject({
            tool: 'Shell',
            permissionOptions: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
            ]
        })
    })

    it('forwards an approved ACP choice and records completion', async () => {
        const harness = createHarness()
        harness.emit(request())
        const permissionRpc = harness.rpcHandlers.get('permission')
        await permissionRpc?.({ id: 'perm-1', approved: true, decision: 'approved' })
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'approved',
            decision: 'approved'
        })
    })

    it('forwards an explicit denial and records completion', async () => {
        const harness = createHarness()
        harness.emit(request())
        const permissionRpc = harness.rpcHandlers.get('permission')
        await permissionRpc?.({ id: 'perm-1', approved: false, decision: 'denied' })
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'reject-once' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'denied',
            decision: 'denied'
        })
    })

    it('fails closed when approved contradicts the decision', async () => {
        for (const response of [
            {
                id: 'perm-1',
                approved: false,
                decision: 'approved',
                optionId: 'allow-once'
            },
            {
                id: 'perm-1',
                approved: true,
                decision: 'denied',
                optionId: 'reject-once'
            }
        ] as const) {
            const harness = createHarness()
            harness.emit(request())
            await harness.rpcHandlers.get('permission')?.(response)

            expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
            expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
                status: 'canceled',
                decision: 'abort'
            })
        }
    })

    it('cancels the native prompt for an abort even when approved is forged', async () => {
        const cancelPrompt = vi.fn(async (_sessionId: string) => {})
        const harness = createHarness(undefined, cancelPrompt)
        harness.emit(request())
        await harness.rpcHandlers.get('permission')?.({
            id: 'perm-1',
            approved: true,
            decision: 'abort'
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
        expect(cancelPrompt).toHaveBeenCalledWith('session-1')
    })

    it('cancels when ACP does not advertise an option matching the decision', async () => {
        const harness = createHarness([
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ])
        harness.emit(request([
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
        ]))
        const permissionRpc = harness.rpcHandlers.get('permission')
        await permissionRpc?.({ id: 'perm-1', approved: true, decision: 'approved' })
        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        })
    })

    it('does not widen a one-time approval into a session grant', async () => {
        const onlySessionGrant = [
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }
        ]
        const harness = createHarness(onlySessionGrant)
        harness.emit(request(onlySessionGrant))

        await harness.rpcHandlers.get('permission')?.({
            id: 'perm-1',
            approved: true,
            decision: 'approved'
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
    })

    it('returns the exact advertised option selected by the web client', async () => {
        const harness = createHarness()
        harness.emit(request())

        await harness.rpcHandlers.get('permission')?.({
            id: 'perm-1',
            approved: true,
            decision: 'approved_for_session',
            optionId: 'allow-always'
        })

        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'allow-always' }])
    })

    it('cancels when a response pairs a decision with the wrong option kind', async () => {
        const harness = createHarness()
        harness.emit(request())

        await harness.rpcHandlers.get('permission')?.({
            id: 'perm-1',
            approved: true,
            decision: 'approved',
            optionId: 'reject-once'
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        })
    })

    it('rejects an option id whose scope contradicts the requested action', async () => {
        const harness = createHarness()
        harness.emit(request())

        await harness.rpcHandlers.get('permission')?.({
            id: 'perm-1',
            approved: true,
            decision: 'approved',
            optionId: 'allow-always'
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
        expect(harness.state().completedRequests?.['perm-1']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        })
    })

    it('renders Reasonix ask requests as structured questions and preserves the selected option id', async () => {
        const harness = createHarness()
        harness.emit({
            id: 'ask-1',
            sessionId: 'session-1',
            toolCallId: 'ask-1',
            title: 'Which path?',
            kind: 'other',
            rawInput: {
                id: 'direction',
                question: 'Which path?',
                multi: false,
                options: [
                    { label: 'A', description: 'Use A' },
                    { label: 'B', description: 'Use B' }
                ]
            },
            options: [
                { optionId: 'direction:1', name: 'A - Use A', kind: 'allow_once' },
                { optionId: 'direction:2', name: 'B - Use B', kind: 'allow_once' },
                { optionId: 'direction:cancel', name: 'Cancel', kind: 'reject_once' }
            ]
        })

        expect(harness.state().requests?.['ask-1']).toMatchObject({
            tool: 'AskUserQuestion',
            arguments: {
                questions: [{
                    id: 'direction',
                    question: 'Which path?',
                    options: [
                        { id: 'direction:1', label: 'A', description: 'Use A' },
                        { id: 'direction:2', label: 'B', description: 'Use B' }
                    ]
                }]
            }
        })

        const permissionRpc = harness.rpcHandlers.get('permission')
        await permissionRpc?.({
            id: 'ask-1',
            approved: true,
            answers: { direction: ['direction:2'] }
        })
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'direction:2' }])
        expect(harness.state().completedRequests?.['ask-1']).toMatchObject({
            status: 'approved',
            answers: { direction: ['direction:2'] }
        })
    })

    it('does not let answer mapping cross the requested permission scope', async () => {
        const makeRequest = (): PermissionRequest => ({
            id: 'ask-scope',
            sessionId: 'session-1',
            toolCallId: 'ask-scope',
            kind: 'other',
            rawInput: {
                id: 'scope',
                question: 'Choose a scope',
                options: [
                    { label: 'Once', description: null },
                    { label: 'Always', description: null }
                ]
            },
            options: [
                { optionId: 'scope:once', name: 'Once', kind: 'allow_once' },
                { optionId: 'scope:always', name: 'Always', kind: 'allow_always' },
                { optionId: 'scope:cancel', name: 'Cancel', kind: 'reject_once' }
            ]
        })

        for (const [decision, answer] of [
            ['approved_for_session', 'scope:once'],
            ['approved', 'scope:always']
        ] as const) {
            const harness = createHarness()
            harness.emit(makeRequest())
            await harness.rpcHandlers.get('permission')?.({
                id: 'ask-scope',
                approved: true,
                decision,
                answers: { scope: [answer] }
            })
            expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'scope:cancel' }])
            expect(harness.state().completedRequests?.['ask-scope']).toMatchObject({
                status: 'denied',
                decision: 'denied'
            })
        }
    })

    it('fails a question closed when approved contradicts the decision', async () => {
        const harness = createHarness()
        harness.emit({
            id: 'ask-conflict',
            sessionId: 'session-1',
            toolCallId: 'ask-conflict',
            kind: 'other',
            rawInput: {
                id: 'direction',
                question: 'Which path?',
                options: [{ label: 'A', description: null }]
            },
            options: [
                { optionId: 'direction:1', name: 'A', kind: 'allow_once' },
                { optionId: 'direction:cancel', name: 'Cancel', kind: 'reject_once' }
            ]
        })

        await harness.rpcHandlers.get('permission')?.({
            id: 'ask-conflict',
            approved: false,
            decision: 'approved',
            answers: { direction: ['direction:1'] }
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
        expect(harness.state().completedRequests?.['ask-conflict']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        })
    })

    it('does not classify an ordinary other-kind tool with question-shaped input as Ask', async () => {
        const harness = createHarness()
        harness.emit({
            id: 'gate-1',
            sessionId: 'session-1',
            toolCallId: 'gate-1',
            title: 'Custom tool',
            kind: 'other',
            rawInput: {
                question: 'Question-like argument',
                options: [{ label: 'A' }]
            },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
            ]
        })

        expect(harness.state().requests?.['gate-1']).toMatchObject({ tool: 'Custom tool' })
        expect(harness.state().requests?.['gate-1']?.arguments).toMatchObject({
            question: 'Question-like argument'
        })
        await harness.rpcHandlers.get('permission')?.({ id: 'gate-1', approved: true, decision: 'approved' })
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    })

    it('cancels a Reasonix question when a generic approval has no answer', async () => {
        const harness = createHarness()
        harness.emit({
            id: 'ask-2',
            sessionId: 'session-1',
            toolCallId: 'ask-2',
            kind: 'other',
            rawInput: {
                id: 'q',
                question: 'Continue?',
                options: [{ label: 'Yes' }]
            },
            options: [
                { optionId: 'q:1', name: 'Yes', kind: 'allow_once' },
                { optionId: 'q:cancel', name: 'Cancel', kind: 'reject_once' }
            ]
        })
        await harness.rpcHandlers.get('permission')?.({ id: 'ask-2', approved: true })
        expect(harness.responses).toEqual([{ outcome: 'selected', optionId: 'q:cancel' }])
        expect(harness.state().completedRequests?.['ask-2']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        })
    })

    it('rejects a question option id that contradicts the deny action', async () => {
        const harness = createHarness()
        harness.emit({
            id: 'ask-3',
            sessionId: 'session-1',
            toolCallId: 'ask-3',
            kind: 'other',
            rawInput: {
                id: 'q',
                question: 'Continue?',
                options: [{ label: 'Yes' }]
            },
            options: [
                { optionId: 'q:1', name: 'Yes', kind: 'allow_once' },
                { optionId: 'q:cancel', name: 'Cancel', kind: 'reject_once' }
            ]
        })

        await harness.rpcHandlers.get('permission')?.({
            id: 'ask-3',
            approved: false,
            decision: 'denied',
            optionId: 'q:1'
        })

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }])
    })
})
