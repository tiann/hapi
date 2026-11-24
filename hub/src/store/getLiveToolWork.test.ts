import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { getToolCallId } from '@hapi/protocol/messages'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

type ToolCallFields = {
    name?: string
    input?: unknown
    status?: string
    nativeTitle?: string
    nativeKind?: string
    nativeName?: string
    nativeArgs?: unknown
    progress?: unknown
}

function toolCallContent(callId: string, fields: ToolCallFields = {}): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: {
                type: 'tool-call',
                callId,
                name: fields.name ?? 'Read',
                ...(fields.input !== undefined ? { input: fields.input } : {}),
                ...(fields.status !== undefined ? { status: fields.status } : {}),
                ...(fields.nativeTitle !== undefined ? { nativeTitle: fields.nativeTitle } : {}),
                ...(fields.nativeKind !== undefined ? { nativeKind: fields.nativeKind } : {}),
                ...(fields.nativeName !== undefined ? { nativeName: fields.nativeName } : {}),
                ...(fields.nativeArgs !== undefined ? { nativeArgs: fields.nativeArgs } : {}),
                ...(fields.progress !== undefined ? { progress: fields.progress } : {})
            }
        }
    }
}

function agentMessageContent(text: string): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'message', message: text }
        }
    }
}

function toolCallResultContent(callId: string, output: unknown): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output }
        }
    }
}

function claudeAssistantContent(blocks: unknown[], extra: Record<string, unknown> = {}): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: { role: 'assistant', content: blocks },
                ...extra
            }
        }
    }
}

function claudeUserContent(blocks: unknown[], extra: Record<string, unknown> = {}): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { role: 'user', content: blocks },
                ...extra
            }
        }
    }
}

describe('getLiveToolWork', () => {
    it('reports open ACP tool calls until their result lands', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-acp-open')

        // Empty session: nothing to wait on.
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-1', { status: 'in_progress' }), 'call-1')
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        // Agent chatter between the call and now does not settle it.
        store.messages.addMessage(session.id, agentMessageContent('still working'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, toolCallResultContent('call-1', 'done'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('closes every call at a human turn for ACP sessions', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-acp-user-turn')

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-1', { status: 'in_progress' }), 'call-1')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'new prompt' } })

        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('treats a terminal-status ACP call as settled even without a result row', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-acp-terminal')

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-1', { status: 'completed' }), 'call-1')
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('closes cancelled ACP calls listed on turn-complete while unlisted child calls stay live', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-acp-turn-complete')

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-cancelled', { status: 'in_progress' }), 'call-cancelled')
        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'call-child',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'call-child')
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        // Parent cancel settles only the ids retired by that prompt — an
        // OpenCode child call that landed earlier must keep blocking archive.
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'cancelled',
                    settledCallIds: ['call-cancelled'],
                },
            },
        })
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, toolCallResultContent('call-child', 'done'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('keeps OpenCode child tool work live across a newer parent human turn (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-child-across-parent')

        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'child-long',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'child-long')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'parent follow-up' } })
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, toolCallResultContent('child-long', 'done'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('reports open claude tool_use pairs until the matching tool_result lands', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-claude-open')

        store.messages.addMessage(session.id, claudeAssistantContent([
            { type: 'text', text: 'let me check' }
        ]))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        store.messages.addMessage(session.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'sleep 60' } }
        ]))
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        // A tool-result carrier continues the turn but settles the call.
        store.messages.addMessage(session.id, claudeUserContent([
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'ran' }
        ]))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        // A second open call re-opens the work; an unrelated result walks past.
        store.messages.addMessage(session.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-2', name: 'Read', input: { path: '/a' } }
        ]))
        store.messages.addMessage(session.id, toolCallResultContent('other-flavor', 'unrelated'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, claudeUserContent([
            { type: 'tool_result', tool_use_id: 'tu-2', content: 'read' }
        ]))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('closes claude tool_use at a human turn or a prompt-shaped user row', () => {
        const store = makeStore()
        const sessionHuman = makeSession(store, 'live-work-claude-human-row')
        store.messages.addMessage(sessionHuman.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }
        ]))
        store.messages.addMessage(sessionHuman.id, { role: 'user', content: { type: 'text', text: 'stop' } })
        expect(store.messages.getLiveToolWork(sessionHuman.id)).toBe(false)

        const sessionPrompt = makeSession(store, 'live-work-claude-prompt-row')
        store.messages.addMessage(sessionPrompt.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }
        ]))
        // A claude user passthrough row with no tool_result is a human prompt.
        store.messages.addMessage(sessionPrompt.id, claudeUserContent([
            { type: 'text', text: 'do something else' }
        ]))
        expect(store.messages.getLiveToolWork(sessionPrompt.id)).toBe(false)
        store.close()
    })

    it('stops at a claude turn-end result row, with newer open calls still detected', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-claude-result')

        const claudeResult = (isError = false): unknown => ({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: 'done', uuid: 'r1' }
            }
        })

        // Finished turn: open-looking call below the turn's result row is closed.
        store.messages.addMessage(session.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-dead', name: 'Bash', input: {} }
        ]))
        // No tool_result ever landed (interrupted turn) — the result row still
        // proves the turn ended.
        store.messages.addMessage(session.id, claudeResult(true))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        // A newer round opens work again, regardless of the older result row.
        store.messages.addMessage(session.id, claudeAssistantContent([
            { type: 'tool_use', id: 'tu-live', name: 'Bash', input: {} }
        ]))
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)
        store.close()
    })

    it('ignores hidden claude passthrough rows (sidechain/meta)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-claude-hidden')

        store.messages.addMessage(session.id, claudeAssistantContent(
            [{ type: 'tool_use', id: 'tu-side', name: 'Task', input: {} }],
            { isSidechain: true }
        ))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })
})
