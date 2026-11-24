import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
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

    it('keeps OpenCode child tool work visible past the transcript lookback (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-child-past-lookback')

        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'child-ancient',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'child-ancient')
        // Push the open child row outside the 200-row scan window.
        for (let i = 0; i < 210; i += 1) {
            store.messages.addMessage(session.id, agentMessageContent(`filler-${i}`))
        }
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'cancelled',
                    settledCallIds: ['child-ancient'],
                },
            },
        })
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('rebuilds open child work from durable rows after a hub restart (#2021)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-live-work-'))
        const dbPath = join(dir, 'hub.db')
        try {
            const store = new Store(dbPath)
            const session = makeSession(store, 'live-work-child-restart')
            const sessionId = session.id
            store.messages.upsertToolCallMessage(sessionId, {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-restart',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child',
                    },
                },
            }, 'child-restart')
            for (let i = 0; i < 210; i += 1) {
                store.messages.addMessage(sessionId, agentMessageContent(`filler-${i}`))
            }
            store.close()

            // New process / hub restart: cold WeakMap, same durable DB.
            const restarted = new Store(dbPath)
            expect(restarted.messages.getLiveToolWork(sessionId)).toBe(true)
            restarted.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('keeps settled child calls closed when a late nonterminal snapshot arrives (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-child-late-snapshot')

        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'child-late',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'child-late')
        store.messages.addMessage(session.id, toolCallResultContent('child-late', 'done'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        // ACP lifetime mapper can re-emit a start after the result with the
        // same id. Settled state must stay latched.
        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'child-late',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'child-late')
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('does not treat an undispatched scheduled prompt as a turn boundary (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-scheduled-mask')

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-open', { status: 'in_progress' }), 'call-open')
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'later' } },
            'sched-1',
            Date.now() + 60_000,
        )
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, toolCallResultContent('call-open', 'done'))
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('does not treat an ordinary uninvoked queued prompt as a turn boundary (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-queued-mask')

        store.messages.upsertToolCallMessage(session.id, toolCallContent('call-open', { status: 'in_progress' }), 'call-open')
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued next' } },
            'queue-1',
        )
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)
        store.close()
    })

    it('treats a running OpenCode child with no open tool as live work (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-child-running')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'running',
                    childSessionId: 'ses_child',
                    childStatus: 'running',
                },
            },
        })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'parent idle' } })
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'completed',
                    childSessionId: 'ses_child',
                    childStatus: 'completed',
                },
            },
        })
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('retires open child work when the worker generation exits (#2021)', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-worker-retire')

        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'child-orphan',
                    name: 'Bash',
                    input: {},
                    status: 'in_progress',
                    childSessionId: 'ses_child',
                },
            },
        }, 'child-orphan')
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        expect(store.messages.retireOpenChildToolWork(session.id)).toBe(true)
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })

    it('persists running-child retirement across hub restart (#2021)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-live-work-retire-'))
        const dbPath = join(dir, 'hub.db')
        try {
            const store = new Store(dbPath)
            const session = makeSession(store, 'live-work-retire-running')
            const sessionId = session.id
            store.messages.addMessage(sessionId, {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'turn-complete',
                        stopReason: 'running',
                        childSessionId: 'ses_child',
                        childStatus: 'running',
                    },
                },
            })
            expect(store.messages.getLiveToolWork(sessionId)).toBe(true)
            expect(store.messages.retireOpenChildToolWork(sessionId)).toBe(true)
            expect(store.messages.getLiveToolWork(sessionId)).toBe(false)
            store.close()

            const restarted = new Store(dbPath)
            expect(restarted.messages.getLiveToolWork(sessionId)).toBe(false)
            restarted.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
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

describe('truncateOpenCodeRewind child settlement (#2021)', () => {
    it('preserves child terminal settlement when rewind removes it past the boundary', () => {
        const store = makeStore()
        const session = makeSession(store, 'live-work-rewind-settle')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'running',
                    childSessionId: 'ses_child',
                    childStatus: 'running',
                },
            },
        })
        const boundary = store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'rewind here' },
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'completed',
                    childSessionId: 'ses_child',
                    childStatus: 'completed',
                },
            },
        })
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)

        store.messages.truncateOpenCodeRewind(session.id, boundary.seq, boundary.id)
        expect(store.messages.getLiveToolWork(session.id)).toBe(false)
        store.close()
    })
})
