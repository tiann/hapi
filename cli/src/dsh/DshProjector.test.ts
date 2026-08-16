import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { DshProjectedMessage } from '@/agent/types'
import { DshProjector } from './DshProjector'

const SESSION = 'hapi-test-001'

function ev(type: string, seq: number, data: unknown, extra?: unknown): SessionEvent {
    return { type, seq, time: 1786600000000 + seq, data, ...(extra as object) } as SessionEvent
}

function textMessage(text: string, id: string, extra?: Partial<DshProjectedMessage>): DshProjectedMessage {
    return { type: 'text', text, id, ...extra } as DshProjectedMessage
}

describe('DshProjector', () => {
    it('streams text deltas as live snapshots and settles on block-end', () => {
        const projector = new DshProjector(SESSION)
        const out = [
            ...projector.onEvent(ev('turn/start', 0, { turn: 1 })),
            ...projector.onEvent(ev('assistant/chunk', 1, {
                turn: 1,
                step: 1,
                chunk: { type: 'block-start', index: 0, blockType: 'text' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 2, {
                turn: 1,
                step: 1,
                chunk: { type: 'text-delta', index: 0, text: 'Hello' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 3, {
                turn: 1,
                step: 1,
                chunk: { type: 'text-delta', index: 0, text: ' world' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 4, {
                turn: 1,
                step: 1,
                chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } }
            }))
        ]

        const live = out.filter((m): m is DshProjectedMessage & { type: 'text' } => m.type === 'text' && m.live === true)
        expect(live.map((m) => m.text)).toEqual(['Hello', 'Hello world'])
        expect(live[0].id).toBe(live[1].id)

        const settled = out.filter((m): m is DshProjectedMessage & { type: 'text' } => m.type === 'text' && m.live !== true)
        expect(settled.map((m) => m.text)).toEqual(['Hello world'])
        expect(settled[0].streamSnapshot).toBe(true)
    })

    it('projects reasoning deltas separately', () => {
        const projector = new DshProjector(SESSION)
        const out = [
            ...projector.onEvent(ev('turn/start', 0, { turn: 1 })),
            ...projector.onEvent(ev('assistant/chunk', 1, {
                turn: 1,
                step: 1,
                chunk: { type: 'block-start', index: 0, blockType: 'reasoning' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 2, {
                turn: 1,
                step: 1,
                chunk: { type: 'reasoning-delta', index: 0, text: 'thinking...' }
            }))
        ]
        const reasoning = out.filter((m) => m.type === 'reasoning')
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]).toMatchObject({ type: 'reasoning', text: 'thinking...', live: true })
    })

    it('emits tool_call from deltas, then tool_result with completed/failed status', () => {
        const projector = new DshProjector(SESSION)
        const deltaOut = [
            ...projector.onEvent(ev('turn/start', 0, { turn: 1 })),
            ...projector.onEvent(ev('assistant/chunk', 1, {
                turn: 1,
                step: 1,
                chunk: { type: 'block-start', index: 0, blockType: 'tool-call' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 2, {
                turn: 1,
                step: 1,
                chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd":' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 3, {
                turn: 1,
                step: 1,
                chunk: { type: 'tool-call-delta', index: 0, argumentsDelta: '"ls"}' }
            }))
        ]
        const liveCalls = deltaOut.filter((m) => m.type === 'tool_call')
        expect(liveCalls).toHaveLength(2)
        expect(liveCalls[1]).toMatchObject({ id: 'call-1', name: 'bash', input: { cmd: 'ls' }, status: 'in_progress' })

        // Formal tool/call event then tool/result.
        const callOut = projector.onEvent(ev('tool/call', 4, {
            turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}'
        }))
        expect(callOut[0]).toMatchObject({ type: 'tool_call', id: 'call-1', status: 'in_progress' })
        expect(callOut[1]).toMatchObject({ type: 'dsh_native' })

        const resultOut = projector.onEvent(ev('tool/result', 5, {
            turn: 1,
            step: 1,
            message: {
                id: 'msg-1',
                role: 'user',
                content: [{
                    type: 'tool-result',
                    toolCallId: 'call-1',
                    content: [{ type: 'text', text: 'total 4' }],
                    isError: false
                }],
                source: { kind: 'tool', callId: 'call-1' }
            }
        }))
        expect(resultOut[0]).toMatchObject({ type: 'tool_result', id: 'call-1', output: 'total 4', status: 'completed' })

        const failedOut = projector.onEvent(ev('tool/result', 6, {
            turn: 1,
            step: 1,
            message: {
                id: 'msg-2',
                role: 'user',
                content: [{
                    type: 'tool-result',
                    toolCallId: 'call-1',
                    content: [{ type: 'text', text: 'boom' }],
                    isError: true
                }],
                source: { kind: 'tool', callId: 'call-1' }
            },
            error: { name: 'BashError', code: 'EXIT_1' }
        }))
        expect(failedOut[0]).toMatchObject({ type: 'tool_result', id: 'call-1', status: 'failed' })
        expect((failedOut[0] as { output: { error: { code: string } } }).output).toMatchObject({ error: { code: 'EXIT_1' } })
    })

    it('does not re-emit streamed text when assistant/message arrives', () => {
        const projector = new DshProjector(SESSION)
        const streamed = [
            ...projector.onEvent(ev('turn/start', 0, { turn: 1 })),
            ...projector.onEvent(ev('assistant/chunk', 1, {
                turn: 1, step: 1,
                chunk: { type: 'block-start', index: 0, blockType: 'text' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 2, {
                turn: 1, step: 1,
                chunk: { type: 'text-delta', index: 0, text: 'Hello!' }
            })),
            ...projector.onEvent(ev('assistant/chunk', 3, {
                turn: 1, step: 1,
                chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello!' } }
            }))
        ]
        expect(streamed.filter((m) => m.type === 'text' && m.live !== true)).toHaveLength(1)

        const settled = projector.onEvent(ev('assistant/message', 4, {
            turn: 1, step: 1,
            message: {
                id: 'm-1', role: 'assistant',
                content: [{ type: 'text', text: 'Hello!' }],
                source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4' }
            },
            usage: { inputTokens: 1, outputTokens: 1 }
        }))
        // The settled emit reuses the SAME stream id as the live/block-end
        // copies (dsh-…-text-0), so the reducer merges instead of rendering a
        // second copy; usage + native journal still arrive.
        const settledTexts = settled.filter((m) => m.type === 'text')
        expect(settledTexts).toHaveLength(1)
        expect(settledTexts[0].id).toBe('dsh-hapi-tes-t1-s1-text-0')
        expect(settled.filter((m) => m.type === 'usage')).toHaveLength(1)
        expect(settled.filter((m) => m.type === 'dsh_native')).toHaveLength(1)
    })

    it('emits turn_complete on turn/end and persists the native events', () => {
        const projector = new DshProjector(SESSION)
        const out = [
            ...projector.onEvent(ev('turn/start', 0, { turn: 1 })),
            ...projector.onEvent(ev('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }))
        ]
        expect(out[0]).toMatchObject({ type: 'dsh_native', event: { type: 'turn/start', seq: 0 } })
        expect(out[1]).toMatchObject({ type: 'turn_complete', stopReason: 'completed', dshSeq: 1 })
        expect(out[2]).toMatchObject({ type: 'dsh_native', event: { type: 'turn/end', seq: 1 } })
    })

    it('emits usage with the latest context window from request/context', () => {
        const projector = new DshProjector(SESSION)
        projector.onEvent(ev('request/context', 1, { provider: 'deepseek-official', model: 'deepseek-v4', contextWindow: 128_000 }))
        const out = projector.onEvent(ev('assistant/message', 2, {
            turn: 1,
            step: 1,
            message: {
                id: 'm1',
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
                source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4' }
            },
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 }
        }))
        const usage = out.find((m) => m.type === 'usage')
        expect(usage).toMatchObject({
            type: 'usage',
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            thoughtTokens: 1,
            cacheReadTokens: 2,
            contextWindow: 128_000
        })
    })

    it('persists unknown plugin events as dsh_native without flattening', () => {
        const projector = new DshProjector(SESSION)
        const out = projector.onEvent(ev('subagent/created', 7, { childSessionId: 'sub-1' } as never))
        expect(out[0]).toMatchObject({
            type: 'dsh_native',
            event: { type: 'subagent/created', seq: 7, dshSessionId: SESSION, data: { childSessionId: 'sub-1' } }
        })
    })

    it('records user/message natively but never re-emits the prompt as text', () => {
        const projector = new DshProjector(SESSION)
        const out = projector.onEvent(ev('user/message', 8, {
            id: 'u1',
            role: 'user',
            content: [{ type: 'text', text: 'do the thing' }],
            source: { kind: 'user', rpcId: 'rpc-1' }
        } as never))
        expect(out).toHaveLength(1)
        expect(out[0].type).toBe('dsh_native')
    })

    it('attaches dshSeq to projected messages for fork anchoring', () => {
        const projector = new DshProjector(SESSION)
        const out = projector.onEvent(ev('tool/call', 9, {
            turn: 2, step: 1, callId: 'call-9', name: 'read', arguments: '{}'
        }))
        expect(out[0]).toMatchObject({ type: 'tool_call', dshSeq: 9 })
    })

    it('tracks approval frame rpcIds for later response routing', () => {
        const projector = new DshProjector(SESSION)
        projector.noteApprovalFrame('approval-1', 'rpc-abc')
        expect(projector.approvalRpcId('approval-1')).toBe('rpc-abc')
        projector.dropApproval('approval-1')
        expect(projector.approvalRpcId('approval-1')).toBeUndefined()
    })

    it('folds state patches into a whole snapshot', () => {
        const projector = new DshProjector(SESSION)
        projector.markSeq(10)
        projector.foldState({ running: true })
        projector.markSeq(11)
        projector.foldState({ running: false, queue: { items: [{ id: 'q1', placement: 'queued', text: 'hi' }] } })
        const snapshot = projector.stateSnapshot()
        expect(snapshot.seq).toBe(11)
        expect(snapshot.running).toBe(false)
        expect(snapshot.queue?.items).toHaveLength(1)
    })
})
