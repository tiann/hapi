import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { DshProjectedMessage } from '@/agent/types'
import type { DshNativeEvent, DshStateSnapshot } from '@hapi/protocol'

/**
 * Projects native DSH session events into HAPI agent messages.
 *
 * - `assistant/chunk` deltas stream as live snapshot messages (stable ids
 *   derived from turn/step/block-index, so reconnect replays merge), then
 *   `assistant/message` / `tool/call` / `tool/result` emit the final forms.
 * - Every non-chunk event is additionally persisted as `dsh_native` so native
 *   identity, ordering and semantics survive hub replay; state-carrying frames
 *   (queue/jobs/goal/questions/approvals) fold into `dsh_state` snapshots.
 *
 * `dshSeq` is attached to every projected message so the web can address the
 * native event log for fork/rewind (session.fork anchors on event seq).
 */
export class DshProjector {
    private readonly steps = new Map<string, StepState>()
    private readonly pendingApprovals = new Map<string, string>()
    private latestContextWindow: number | null = null
    private currentTurn = 0
    private latestProjections: Partial<DshStateSnapshot> = {}

    constructor(private readonly dshSessionId: string) {}

    /** A stable message id for one step block (survives reconnect/resume). */
    private blockId(turn: number, step: number, index: number, kind: 'text' | 'reasoning' | 'tool'): string {
        return `dsh-${this.dshSessionId.slice(0, 8)}-t${turn}-s${step}-${kind}-${index}`
    }

    private stepState(turn: number, step: number): StepState {
        const key = `${turn}:${step}`
        let state = this.steps.get(key)
        if (!state) {
            state = { turn, step, blocks: new Map() }
            this.steps.set(key, state)
        }
        return state
    }

    /** Feed one native session event; returns messages to forward. */
    onEvent(event: SessionEvent): DshProjectedMessage[] {
        const out: DshProjectedMessage[] = []
        const native: DshNativeEvent = {
            seq: event.seq,
            type: event.type,
            time: event.time,
            data: event.data,
            dshSessionId: this.dshSessionId,
            ...('surfaceOp' in event && event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
            ...('sourceEventSeqs' in event && event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {})
        }

        switch (event.type) {
            case 'turn/start': {
                this.currentTurn = event.data.turn
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'turn/end': {
                out.push({ type: 'turn_complete', stopReason: event.data.reason.kind, dshSeq: event.seq })
                for (const [key, state] of this.steps) {
                    if (state.turn === event.data.turn) {
                        this.steps.delete(key)
                    }
                }
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'step/start':
            case 'step/end': {
                this.stepState(event.data.turn, event.data.step)
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'assistant/chunk': {
                this.handleChunk(event.data.turn, event.data.step, event.data.chunk, out)
                break
            }
            case 'assistant/message': {
                const { turn, step, message, usage } = event.data
                const state = this.stepState(turn, step)
                state.finished = true
                // Text/reasoning are already emitted per block when their
                // block-end chunks arrive (same ids the live snapshots used).
                // Re-emitting here with a different id would render a second
                // copy of the same content. Only fall back to a full emit when
                // the step produced no streamed blocks at all.
                        const streamedBlocks = state.streamed
                if (!streamedBlocks) {
                    const text = message.content
                        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                        .map((block) => block.text)
                        .join('\n\n')
                    if (text.length > 0) {
                        out.push({
                            type: 'text',
                            text,
                            id: `dsh-${this.dshSessionId.slice(0, 8)}-t${turn}-s${step}-final`,
                            streamSnapshot: true,
                            dshSeq: event.seq,
                            dshMessageId: message.id
                        })
                    }
                    const reasoningText = message.content
                        .filter((block): block is { type: 'reasoning'; text: string } => block.type === 'reasoning')
                        .map((block) => block.text)
                        .filter((text) => text.length > 0)
                        .join('\n')
                    if (reasoningText.length > 0) {
                        out.push({
                            type: 'reasoning',
                            text: reasoningText,
                            id: `dsh-${this.dshSessionId.slice(0, 8)}-t${turn}-s${step}-reasoning-final`,
                            streamSnapshot: true,
                            dshSeq: event.seq
                        })
                    }
                }
                if (usage) {
                    this.emitUsage(usage, out, event.seq)
                }
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'tool/call': {
                const { callId, name, arguments: rawArguments } = event.data
                out.push({
                    type: 'tool_call',
                    id: callId,
                    name,
                    input: safeJsonParse(rawArguments),
                    status: 'in_progress',
                    dshSeq: event.seq
                })
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'tool/result': {
                const { message, error } = event.data
                const resultBlock = message.content[0]
                const callId = resultBlock?.type === 'tool-result' ? resultBlock.toolCallId : 'unknown'
                const outputText = resultBlock?.content
                    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n') ?? ''
                out.push({
                    type: 'tool_result',
                    id: callId,
                    output: error
                        ? { error: { name: error.name, code: error.code }, output: outputText }
                        : outputText,
                    status: error ? 'failed' : 'completed',
                    dshSeq: event.seq
                })
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'user/message': {
                // User prompts are recorded by HAPI's own message pipeline; the
                // native event is still persisted for replay fidelity (fork
                // anchors and cross-session search benefit from the seq).
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'request/context': {
                if (event.data.contextWindow !== undefined) {
                    this.latestContextWindow = event.data.contextWindow
                }
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'request/header': {
                // Model selection is served by session.models; the header is
                // still persisted as the durable logged target.
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
            case 'session/end-seed': {
                break
            }
            default: {
                // todo/write, plan, goal, subagent, workflow, job and any
                // plugin-extended event types: persist natively, never flatten.
                out.push({ type: 'dsh_native', event: native, dshSeq: event.seq })
                break
            }
        }
        return out
    }

    private handleChunk(turn: number, step: number, chunk: StreamChunk, out: DshProjectedMessage[]): void {
        const state = this.stepState(turn, step)
        switch (chunk.type) {
            case 'block-start': {
                state.streamed = true
                const kind: BlockState['kind'] = chunk.blockType === 'text' || chunk.blockType === 'reasoning' || chunk.blockType === 'tool-call'
                    ? chunk.blockType
                    : 'text'
                state.blocks.set(chunk.index, {
                    kind,
                    text: '',
                    args: '',
                    callId: undefined,
                    name: undefined
                })
                break
            }
            case 'text-delta': {
                const block = state.blocks.get(chunk.index)
                if (!block || block.kind !== 'text') return
                block.text += chunk.text
                out.push({
                    type: 'text',
                    text: block.text,
                    id: this.blockId(turn, step, chunk.index, 'text'),
                    live: true,
                    streamSnapshot: true
                })
                break
            }
            case 'reasoning-delta': {
                const block = state.blocks.get(chunk.index)
                if (!block || block.kind !== 'reasoning') return
                block.text += chunk.text
                out.push({
                    type: 'reasoning',
                    text: block.text,
                    id: this.blockId(turn, step, chunk.index, 'reasoning'),
                    live: true,
                    streamSnapshot: true
                })
                break
            }
            case 'tool-call-delta': {
                const block = state.blocks.get(chunk.index)
                if (!block || block.kind !== 'tool-call') return
                if (chunk.id !== undefined) block.callId = chunk.id
                if (chunk.name !== undefined) block.name = chunk.name
                block.args += chunk.argumentsDelta
                if (block.callId !== undefined && block.name !== undefined) {
                    out.push({
                        type: 'tool_call',
                        id: block.callId,
                        name: block.name,
                        input: safeJsonParse(block.args),
                        status: 'in_progress'
                    })
                }
                break
            }
            case 'block-end': {
                const block = state.blocks.get(chunk.index)
                if (!block) return
                if (block.kind === 'text' && block.text.length > 0) {
                    out.push({
                        type: 'text',
                        text: block.text,
                        id: this.blockId(turn, step, chunk.index, 'text'),
                        streamSnapshot: true
                    })
                } else if (block.kind === 'reasoning' && block.text.length > 0) {
                    out.push({
                        type: 'reasoning',
                        text: block.text,
                        id: this.blockId(turn, step, chunk.index, 'reasoning'),
                        streamSnapshot: true
                    })
                } else if (block.kind === 'tool-call' && block.callId !== undefined && block.name !== undefined) {
                    out.push({
                        type: 'tool_call',
                        id: block.callId,
                        name: block.name,
                        input: safeJsonParse(block.args),
                        status: 'in_progress'
                    })
                }
                state.blocks.delete(chunk.index)
                break
            }
            case 'usage': {
                // usage rides assistant/message; the chunk-level usage is the
                // same accounting and is ignored here to avoid double emits.
                break
            }
            case 'finish': {
                break
            }
        }
    }

    private emitUsage(usage: TokenUsage, out: DshProjectedMessage[], dshSeq: number): void {
        out.push({
            type: 'usage',
            inputTokens: Number(usage.inputTokens ?? 0),
            outputTokens: Number(usage.outputTokens ?? 0),
            totalTokens: Number((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
            thoughtTokens: Number(usage.reasoningTokens ?? 0),
            cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
            cacheCreationTokens: Number(usage.cacheWriteTokens ?? 0),
            contextTokens: this.latestContextWindow !== null ? 0 : undefined,
            contextWindow: this.latestContextWindow ?? undefined,
            dshSeq
        })
    }

    /** Register an answerable approval frame: approvalId → frame rpcId. */
    noteApprovalFrame(approvalId: string, rpcId: string): void {
        this.pendingApprovals.set(approvalId, rpcId)
    }

    approvalRpcId(approvalId: string): string | undefined {
        return this.pendingApprovals.get(approvalId)
    }

    dropApproval(approvalId: string): void {
        this.pendingApprovals.delete(approvalId)
    }

    /** Fold one state-carrying frame into the latest snapshot. */
    foldState(patch: Partial<DshStateSnapshot>): DshStateSnapshot {
        this.latestProjections = { ...this.latestProjections, ...patch }
        return this.stateSnapshot()
    }

    /** Current whole-session state snapshot. */
    stateSnapshot(): DshStateSnapshot {
        return {
            seq: this.latestSeq,
            ...this.latestProjections
        }
    }

    private latestSeq = 0
    markSeq(seq: number): void {
        if (seq > this.latestSeq) {
            this.latestSeq = seq
        }
    }
}

type BlockState = {
    kind: 'text' | 'reasoning' | 'tool-call'
    text: string
    args: string
    callId?: string
    name?: string
}

type StepState = {
    turn: number
    step: number
    blocks: Map<number, BlockState>
    /** Any block-start chunk observed (distinct from final assistant/message). */
    streamed?: boolean
    finished?: boolean
}

function safeJsonParse(raw: string): unknown {
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}
