import { describe, expect, it } from 'bun:test'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { ACTIONS, handleCallback } from './callbacks'
import { createCallbackData } from './renderer'

function createHarness(action: typeof ACTIONS.APPROVE | typeof ACTIONS.DENY) {
    const requestId = 'current-request-12345678'
    const session = {
        id: 'session-12345678',
        namespace: 'default',
        active: true,
        agentState: {
            controlledByUser: false,
            requests: {
                [requestId]: {
                    tool: 'Bash',
                    arguments: { command: 'echo current' },
                    createdAt: 1
                }
            },
            completedRequests: {}
        }
    } as unknown as Session
    const sessions = [session]
    const permissionCalls: Array<{ action: string; sessionId: string; requestId: string }> = []
    const answers: Array<string | undefined> = []
    const edits: string[] = []
    const syncEngine = {
        getSessionsByNamespace: () => sessions,
        approvePermission: async (sessionId: string, approvedRequestId: string) => {
            permissionCalls.push({ action: ACTIONS.APPROVE, sessionId, requestId: approvedRequestId })
        },
        denyPermission: async (sessionId: string, deniedRequestId: string) => {
            permissionCalls.push({ action: ACTIONS.DENY, sessionId, requestId: deniedRequestId })
        }
    } as unknown as SyncEngine

    return {
        data: createCallbackData(action, session.id, 'stale-request'),
        session,
        sessions,
        requestId,
        permissionCalls,
        answers,
        edits,
        ctx: {
            syncEngine,
            namespace: 'default',
            answerCallback: async (text?: string) => { answers.push(text) },
            editMessage: async (text: string) => { edits.push(text) }
        }
    }
}

describe('Telegram permission callbacks', () => {
    for (const action of [ACTIONS.APPROVE, ACTIONS.DENY] as const) {
        it(`does not apply a stale ${action} callback to the current request`, async () => {
            const harness = createHarness(action)

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Request not found or already processed'])
            expect(harness.edits).toEqual([])
        })
    }

    for (const action of [ACTIONS.APPROVE, ACTIONS.DENY] as const) {
        it(`does not apply a ${action} callback that omits the request prefix`, async () => {
            const harness = createHarness(action)
            harness.data = createCallbackData(action, harness.session.id)

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Request not found or already processed'])
        })
    }

    for (const action of [ACTIONS.APPROVE, ACTIONS.DENY] as const) {
        it(`does not guess a ${action} request when its prefix is ambiguous`, async () => {
            const harness = createHarness(action)
            const requests = harness.session.agentState?.requests ?? {}
            harness.session.agentState = {
                ...harness.session.agentState,
                requests: {
                    ...requests,
                    'current-request-second': {
                        tool: 'Bash',
                        arguments: { command: 'echo second' },
                        createdAt: 2
                    }
                }
            }
            harness.data = createCallbackData(action, harness.session.id, 'current-request-')

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Request not found or already processed'])
        })
    }

    for (const action of [ACTIONS.APPROVE, ACTIONS.DENY] as const) {
        it(`does not apply a ${action} callback with an empty session prefix`, async () => {
            const harness = createHarness(action)
            harness.data = `${action}::${harness.requestId}`

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Session not found'])
            expect(harness.edits).toEqual([])
        })

        it(`does not apply a ${action} callback with a stale session prefix`, async () => {
            const harness = createHarness(action)
            harness.data = createCallbackData(action, 'missing-session', harness.requestId)

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Session not found'])
            expect(harness.edits).toEqual([])
        })

        it(`does not guess a ${action} session when its prefix is ambiguous`, async () => {
            const harness = createHarness(action)
            harness.sessions.push({
                ...harness.session,
                id: 'session-87654321'
            })
            harness.data = createCallbackData(action, harness.session.id, harness.requestId)

            await handleCallback(harness.data, harness.ctx)

            expect(harness.permissionCalls).toEqual([])
            expect(harness.answers).toEqual(['Session not found'])
            expect(harness.edits).toEqual([])
        })
    }
})
