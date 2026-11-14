import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

type RegisteredHandler = (params: unknown) => Promise<void>

function createHarness() {
    const registered = new Map<string, RegisteredHandler>()
    const stateUpdates: Array<(state: unknown) => unknown> = []
    const client = {
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RegisteredHandler) => {
                registered.set(method, handler)
            })
        },
        updateAgentState: vi.fn((fn: (state: unknown) => unknown) => {
            stateUpdates.push(fn)
            return fn({})
        })
    }
    const backend = {
        onPermissionRequest: vi.fn(),
        respondToPermission: vi.fn(async () => {}),
        cancelPrompt: vi.fn(async () => {})
    }
    return { client, backend, registered, stateUpdates }
}

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

async function permissionRpcRespond(harness: ReturnType<typeof createHarness>, payload: unknown): Promise<void> {
    const handler = harness.registered.get(RPC_METHODS.Permission)
    if (!handler) throw new Error('permission RPC handler was not registered')
    await handler(payload)
}

import { AcpPermissionHandler } from './AcpPermissionHandler'

const QUESTIONS_INPUT = {
    questions: [
        {
            id: 'target',
            question: 'Deploy to which environment?',
            options: [{ label: 'Staging' }, { label: 'Production' }]
        }
    ]
}

function pendingEntryAfter(handler: AcpPermissionHandler): { id: string; entry: { tool: string; arguments: unknown } } | null {
    // The BasePermissionHandler records the pending request into agent state
    // through updateAgentState; recover the single pending entry.
    const calls = (handler as unknown as { client: { updateAgentState: { mock: { calls: Array<[(s: unknown) => unknown]> } } } })
        .client.updateAgentState.mock.calls
    for (let i = calls.length - 1; i >= 0; i -= 1) {
        const state = calls[i][0]({ requests: {} }) as { requests?: Record<string, { tool: string; arguments: unknown }> }
        const entries = Object.entries(state.requests ?? {})
        if (entries.length > 0) return { id: entries[0][0], entry: entries[0][1] }
    }
    return null
}

describe('AcpPermissionHandler.askUserQuestion', () => {
    let harness: ReturnType<typeof createHarness>
    let handler: AcpPermissionHandler

    beforeEach(() => {
        harness = createHarness()
        handler = new AcpPermissionHandler(
            harness.client as never,
            harness.backend as never,
            () => undefined
        )
    })

    it('registers a pending ask_user_question request and resolves answers from the Permission RPC', async () => {
        const pendingPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        const pending = pendingEntryAfter(handler)
        expect(pending).not.toBeNull()
        expect(pending!.entry.tool).toBe('ask_user_question')
        expect(pending!.entry.arguments).toEqual(QUESTIONS_INPUT)

        await permissionRpcRespond(harness, {
            id: pending!.id,
            approved: true,
            answers: { '0': ['Staging'] }
        })

        await expect(pendingPromise).resolves.toEqual({
            status: 'answered',
            answers: [{ id: 'target', selected: ['Staging'] }]
        })
        // No backend request existed for the synthetic id: respondToPermission
        // must never fire for it.
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
    })

    it('translates multi_select into the client card spelling', async () => {
        // The MCP schema spells it snake_case while every HAPI client card
        // reads camelCase multiSelect; untranslated, a multi-select question
        // renders as single-select and the UI forbids choosing several.
        const pendingPromise = handler.askUserQuestion({
            questions: [
                {
                    id: 'checks',
                    question: 'Which checks should run?',
                    multi_select: true,
                    options: [{ label: 'lint' }, { label: 'test' }]
                },
                {
                    id: 'note',
                    question: 'Anything else?',
                    multi_select: false
                }
            ]
        })
        const pending = pendingEntryAfter(handler)!
        expect(pending.entry.arguments).toEqual({
            questions: [
                {
                    id: 'checks',
                    question: 'Which checks should run?',
                    multi_select: true,
                    multiSelect: true,
                    options: [{ label: 'lint' }, { label: 'test' }]
                },
                {
                    id: 'note',
                    question: 'Anything else?',
                    multi_select: false,
                    multiSelect: false
                }
            ]
        })

        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['lint', 'test'] }
        })
        await expect(pendingPromise).resolves.toEqual({
            status: 'answered',
            answers: [
                { id: 'checks', selected: ['lint', 'test'] },
                { id: 'note', selected: [] }
            ]
        })
    })

    it('maps free-text answers to custom', async () => {
        const pendingPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        const pending = pendingEntryAfter(handler)!
        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': ['use the blue cluster'] }
        })
        await expect(pendingPromise).resolves.toEqual({
            status: 'answered',
            answers: [{ id: 'target', selected: [], custom: 'use the blue cluster' }]
        })
    })

    it('denies when approved without any answer content', async () => {
        const pendingPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        const pending = pendingEntryAfter(handler)!
        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: true,
            answers: { '0': [] }
        })
        await expect(pendingPromise).resolves.toMatchObject({ status: 'denied' })
    })

    it('denies on an explicit deny response', async () => {
        const pendingPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        const pending = pendingEntryAfter(handler)!
        await permissionRpcRespond(harness, {
            id: pending.id,
            approved: false,
            reason: 'not now'
        })
        await expect(pendingPromise).resolves.toEqual({ status: 'denied', reason: 'not now' })
    })

    it('cancels through cancelAll (abort / session teardown)', async () => {
        const pendingPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        await handler.cancelAll('Session ended')
        await expect(pendingPromise).resolves.toMatchObject({ status: 'canceled' })
    })

    it('supersedes a prior pending ask-user card when a newer question escalates', async () => {
        // Agents with a per-call MCP timeout (DSH: 60s) make the model retry
        // the tool call; each retry escalates a new question while the old
        // card is still pending. Only the newest card may stay interactive —
        // the prior one resolves canceled (state moves to completedRequests)
        // the instant the new question arrives, so dialogs never stack and
        // nothing gets silently answered out from under the user.
        const first = handler.askUserQuestion(QUESTIONS_INPUT)
        const firstPending = pendingEntryAfter(handler)!

        const second = handler.askUserQuestion(QUESTIONS_INPUT)
        const secondPending = pendingEntryAfter(handler)!

        // The first escalation resolved as superseded; only the second id is
        // still answerable.
        await expect(first).resolves.toMatchObject({ status: 'canceled' })
        const firstOutcome = await first
        expect(firstOutcome.status === 'canceled' && firstOutcome.reason).toContain('Superseded')

        // Late approval for the superseded id must not disturb anything.
        await permissionRpcRespond(harness, {
            id: firstPending.id,
            approved: true,
            answers: { '0': ['Staging'] }
        })
        // Answering the superseded id is a no-op for the second promise.
        await permissionRpcRespond(harness, {
            id: secondPending.id,
            approved: true,
            answers: { '0': ['Production'] }
        })
        await expect(second).resolves.toEqual({
            status: 'answered',
            answers: [{ id: 'target', selected: ['Production'] }]
        })
        expect(harness.backend.respondToPermission).not.toHaveBeenCalled()
    })

    it('coexists with backend permission requests on the same RPC channel', async () => {
        // A real ACP request_permission (e.g. a gated write tool) and a
        // synthetic ask-user can be pending simultaneously; each response
        // routes to its own path.
        const askPromise = handler.askUserQuestion(QUESTIONS_INPUT)
        const askPending = pendingEntryAfter(handler)!

        const acpRequest = {
            sessionId: 'sess-1',
            id: 'acp-req-1',
            toolCallId: 'call-1',
            kind: 'other' as const,
            title: 'Run command',
            options: [
                { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
                { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
            ]
        }
        ;(harness.backend.onPermissionRequest as unknown as { mock: { calls: Array<[cb: (r: unknown) => void]> } })
            .mock.calls[0][0](acpRequest)

        await permissionRpcRespond(harness, { id: 'acp-req-1', approved: true })
        await permissionRpcRespond(harness, {
            id: askPending.id,
            approved: true,
            answers: { '0': ['Production'] }
        })

        expect(harness.backend.respondToPermission).toHaveBeenCalledTimes(1)
        await expect(askPromise).resolves.toEqual({
            status: 'answered',
            answers: [{ id: 'target', selected: ['Production'] }]
        })
    })
})
