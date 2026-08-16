import type { MuxFrame, HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { logger } from '@/ui/logger'
import type { DshProjectedMessage } from '@/agent/types'
import type {
    DshNativeEvent,
    DshPendingApproval,
    DshQueueItem,
    DshStateSnapshot
} from '@hapi/protocol'
import { DshClient } from './DshClient'
import { DshProjector } from './DshProjector'

export type DshEventBridgeOptions = {
    client: DshClient
    dshSessionId: string
    projector: DshProjector
    /** Forward one projected agent message (text/tool/usage/native/state…). */
    onMessage: (message: DshProjectedMessage) => void
    /** Forward a state snapshot message (dsh_state). */
    onStateSnapshot: (snapshot: DshStateSnapshot) => void
    /** Register a pending approval in HAPI agentState.requests. */
    onApprovalPending: (approval: DshPendingApproval) => void
    /** Resolve a pending approval (removed from agentState.requests). */
    onApprovalResolved: (approvalId: string) => void
    /** Host running-status flip (host/session-status). */
    onHostStatus: (running: boolean) => void
    /** Live agent failure with no turn position (host/agent-error). */
    onAgentError: (message: string) => void
    /** Forwarded host event (agent-preset/selected, commands/change, …). */
    onRemoteEvent?: (event: string, args: unknown[]) => void
    /** Native seq cursor advanced (batched by the caller for metadata). */
    onCursor?: (seq: number) => void
    logTag?: string
}

const CURSOR_FLUSH_MS = 1_000

/**
 * Pumps the official mux + host streams and dispatches frames:
 *
 * - `session/event` → DshProjector (streaming + native persistence); events
 *   from subagent children are persisted as `dsh_native` under the child's
 *   native session id.
 * - `approval/requested|resolved` → HAPI agentState permission lifecycle.
 * - `question/requested|resolved`, `session/queue`, `session/jobs`,
 *   `session/projection` → `dsh_state` snapshots.
 * - `host/*` frames → running status / agent errors / subagent tracking.
 *
 * The pump owns no ordering guarantees beyond the official stream order; the
 * cursor callback lets the caller persist the highest forwarded seq so a
 * reconnect gap-fill can resume at-most-once.
 */
export class DshEventBridge {
    private readonly projector: DshProjector
    private readonly logTag: string
    private readonly childProjectors = new Map<string, DshProjector>()
    private lastCursorFlush = 0

    constructor(private readonly options: DshEventBridgeOptions) {
        this.projector = options.projector
        this.logTag = options.logTag ?? 'dsh'
    }

    async start(signal: AbortSignal): Promise<void> {
        // Reconnect loop: EITHER stream closing ends the generation (a dead
        // socket must not wait on the other), then backfill the gap since the
        // last forwarded seq and re-open both streams. Each generation gets
        // its own AbortController so the loser of the race is torn down.
        while (!signal.aborted) {
            const generation = new AbortController()
            const onOuterAbort = () => generation.abort()
            signal.addEventListener('abort', onOuterAbort, { once: true })
            const mux = this.options.client.muxStream(generation.signal)
            const host = this.options.client.hostStream(generation.signal)
            const muxDone = this.pumpMux(mux, generation.signal)
            const hostDone = this.pumpHost(host, generation.signal)
            await Promise.race([muxDone, hostDone])
            generation.abort()
            await Promise.allSettled([muxDone, hostDone])
            signal.removeEventListener('abort', onOuterAbort)
            if (signal.aborted) break
            logger.debug(`[${this.logTag}] streams closed; backfilling after seq ${this.lastForwardedSeq}`)
            await this.backfillAfterCursor()
        }
    }

    /** Highest native seq already forwarded (dedupe + gap-fill anchor). */
    private lastForwardedSeq = -1

    /**
     * Replay native events after the last forwarded seq from session.history.
     *
     * History pages go backwards (beforeSeq = older); the cursor must not
     * advance while older pages are still being read, otherwise the filter
     * would skip them. Collect every page first (walking back until a page
     * contains the cursor), then replay the collected events in order.
     */
    private async backfillAfterCursor(): Promise<void> {
        const anchor = this.lastForwardedSeq
        const collected: Array<import('@deepseek-ai/dsh-session/types').SessionEvent> = []
        let beforeSeq: number | undefined
        while (true) {
            let events: Array<import('@deepseek-ai/dsh-session/types').SessionEvent>
            let hasMore = false
            try {
                const pageResult = await this.options.client.sessionHistory({
                    sessionId: this.options.dshSessionId,
                    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
                    maxMessages: 200
                })
                events = pageResult.events.map((entry) => entry.event)
                hasMore = pageResult.hasMore
            } catch (error) {
                logger.debug(`[${this.logTag}] backfill page failed: ${error instanceof Error ? error.message : String(error)}`)
                return
            }
            collected.push(...events)
            const reachedAnchor = events.some((event) => event.seq <= anchor)
            if (!hasMore || reachedAnchor) break
            const oldest = events.reduce((min, event) => Math.min(min, event.seq), Number.MAX_SAFE_INTEGER)
            beforeSeq = oldest
        }
        collected
            .filter((event) => event.seq > anchor)
            .sort((a, b) => a.seq - b.seq)
            .forEach((event) => {
                if (event.seq <= this.lastForwardedSeq) return
                this.handleSessionEvent(this.options.dshSessionId, event)
            })
    }

    /** Seed foldable projections from the history tail's projections block. */
    private async bootstrapProjections(): Promise<void> {
        // The host computes projection watermarks lazily; a brand-new session
        // may answer with an empty block for a moment, so retry briefly.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const page = await this.options.client.sessionHistory({
                    sessionId: this.options.dshSessionId,
                    maxMessages: 1
                })
                const projections = page.projections
                if (projections && typeof projections.asOfSeq === 'number') {
                    for (const [key, value] of Object.entries(projections.values)) {
                        if (value === undefined) continue
                        this.handleProjection(key, value, projections.asOfSeq)
                    }
                    return
                }
            } catch (error) {
                logger.debug(`[${this.logTag}] projection bootstrap attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 1_500))
        }
    }

    private async pumpMux(mux: AsyncIterable<RpcRequest<MuxFrame>>, signal: AbortSignal): Promise<void> {
        for await (const envelope of mux) {
            if (signal.aborted) return
            const frame = envelope.payload
            try {
                this.handleMuxFrame(frame, envelope.rpcId)
            } catch (error) {
                logger.debug(`[${this.logTag}] mux frame handler error:`, error)
            }
        }
    }

    private async pumpHost(host: AsyncIterable<RpcRequest<HostFrame>>, signal: AbortSignal): Promise<void> {
        for await (const envelope of host) {
            if (signal.aborted) return
            const frame = envelope.payload
            try {
                this.handleHostFrame(frame)
            } catch (error) {
                logger.debug(`[${this.logTag}] host frame handler error:`, error)
            }
        }
    }

    private handleMuxFrame(frame: MuxFrame, rpcId: string): void {
        switch (frame.type) {
            case 'session/event': {
                this.handleSessionEvent(frame.sessionId, frame.event)
                break
            }
            case 'session/subscribed': {
                logger.debug(`[${this.logTag}] subscribed ${frame.sessionId} lastSeq=${frame.lastSeq}`)
                // The host only pushes projections on change; the history tail
                // carries the current snapshot. Seed once, after the host has
                // attached the session (subscribed), so permissions/goal/title
                // are available before any change.
                if (frame.sessionId === this.options.dshSessionId && !this.projectionsSeeded) {
                    this.projectionsSeeded = true
                    void this.bootstrapProjections()
                }
                break
            }
            case 'approval/requested': {
                this.projector.noteApprovalFrame(frame.approvalId, rpcId)
                const approval: DshPendingApproval = {
                    approvalId: frame.approvalId,
                    toolName: frame.toolName,
                    ...(frame.callId ? { callId: frame.callId } : {}),
                    ...(frame.reason ? { reason: frame.reason } : {})
                }
                this.approvals = [...this.approvals.filter((a) => a.approvalId !== approval.approvalId), approval]
                this.options.onApprovalPending(approval)
                this.emitState({ seq: this.seqOf(), approvals: this.approvals })
                break
            }
            case 'approval/resolved': {
                this.projector.dropApproval(frame.approvalId)
                this.approvals = this.approvals.filter((a) => a.approvalId !== frame.approvalId)
                this.options.onApprovalResolved(frame.approvalId)
                this.emitState({ seq: this.seqOf(), approvals: this.approvals })
                break
            }
            case 'question/requested': {
                const items = frame.questions.map((q) => ({
                    id: q.id,
                    question: q.question,
                    ...(q.detail ? { detail: q.detail } : {}),
                    ...(q.header ? { header: q.header } : {}),
                    ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
                    ...(q.multiSelect ? { multiSelect: true } : {}),
                    ...(q.intent ? { intent: q.intent } : {})
                }))
                this.emitState({ seq: this.seqOf(), questions: { questionRpcId: rpcId, items } })
                break
            }
            case 'question/resolved': {
                this.emitState({ seq: this.seqOf(), questions: undefined })
                break
            }
            case 'session/queue': {
                const items: DshQueueItem[] = frame.items.map((item) => {
                    const textBlock = item.message.content.find((block): block is { type: 'text'; text: string } => block.type === 'text')
                    return {
                        id: item.id,
                        placement: item.placement,
                        text: textBlock?.text ?? '',
                        ...(item.message.content.some((block) => block.type === 'image') ? { hasImages: true } : {})
                    }
                })
                this.emitState({ seq: this.seqOf(), queue: { items } })
                break
            }
            case 'session/jobs': {
                this.emitState({
                    seq: this.seqOf(),
                    jobs: {
                        jobs: frame.jobs.map((job) => ({
                            id: job.id,
                            kind: job.kind,
                            label: job.label,
                            status: job.status,
                            ...(job.detail ? { detail: job.detail } : {}),
                            startedAt: job.startedAt,
                            ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {})
                        }))
                    }
                })
                break
            }
            case 'session/projection': {
                this.handleProjection(frame.key, frame.value, frame.seq)
                break
            }
            case 'stream/error': {
                this.options.onAgentError(frame.error.message)
                break
            }
        }
    }

    private subagentIds = new Set<string>()
    private projectionsSeeded = false

    private emitSubagentCount(seq: number): void {
        this.emitState({ seq, subagentCount: this.subagentIds.size })
    }

    private handleHostFrame(frame: HostFrame): void {
        switch (frame.type) {
            case 'host/session-status': {
                if (frame.sessionId === this.options.dshSessionId) {
                    this.options.onHostStatus(frame.running)
                    this.emitState({ seq: this.seqOf(), running: frame.running })
                }
                break
            }
            case 'host/agent-error': {
                if (frame.sessionId === this.options.dshSessionId) {
                    this.options.onAgentError(frame.message)
                }
                break
            }
            case 'host/session-added': {
                if (frame.origin === 'subagent') {
                    this.childProjectors.set(frame.sessionId, new DshProjector(frame.sessionId))
                    this.subagentIds.add(frame.sessionId)
                    this.emitSubagentCount(this.seqOf())
                }
                break
            }
            case 'host/session-removed': {
                this.childProjectors.delete(frame.sessionId)
                if (this.subagentIds.delete(frame.sessionId)) {
                    this.emitSubagentCount(this.seqOf())
                }
                break
            }
            case 'host/remote-event': {
                if (frame.event === 'agent-preset/selected' && frame.args[0] !== undefined) {
                    const preset = isObject(frame.args[0]) ? asString(frame.args[0].preset ?? frame.args[0].id) : undefined
                    if (preset !== undefined) {
                        this.emitState({ seq: this.seqOf(), agentPreset: preset })
                    }
                }
                this.options.onRemoteEvent?.(frame.event, frame.args)
                break
            }
            case 'host/workspace-changed':
            case 'host/workspace-removed':
            case 'host/workspace-order-changed':
            case 'host/archived-sessions-changed': {
                // HAPI owns the outer session/workspace UX; DSH workspace frames
                // are intentionally not surfaced.
                break
            }
        }
    }

    private handleSessionEvent(sessionId: string, event: SessionEvent): void {
        if (sessionId === this.options.dshSessionId) {
            if (event.seq <= this.lastForwardedSeq) return
            this.lastForwardedSeq = event.seq
            this.projector.markSeq(event.seq)
            for (const message of this.projector.onEvent(event)) {
                this.options.onMessage(message)
            }
            this.options.onCursor?.(event.seq)
            return
        }
        // Subagent child events: persist natively under the child's session id
        // so subagent activity survives replay without flattening.
        let child = this.childProjectors.get(sessionId)
        if (!child) {
            child = new DshProjector(sessionId)
            this.childProjectors.set(sessionId, child)
        }
        child.markSeq(event.seq)
        for (const message of child.onEvent(event)) {
            if (message.type === 'dsh_native' || message.type === 'turn_complete' || message.type === 'error') {
                this.options.onMessage(message)
            }
        }
    }

    private handleProjection(key: string, value: unknown, seq: number): void {
        if (key === 'permissions' && isObject(value)) {
            const options = Array.isArray(value.options)
                ? value.options
                    .filter((o): o is Record<string, unknown> => isObject(o))
                    .map((o) => ({
                        value: asString(o.value) ?? '',
                        name: asString(o.name) ?? asString(o.value) ?? '',
                        ...(asString(o.description) !== undefined ? { description: asString(o.description)! } : {})
                    }))
                    .filter((o) => o.value.length > 0)
                : []
            const currentValue = asString(value.currentValue)
            if (options.length > 0 && currentValue !== undefined) {
                this.emitState({ seq, permissionPresets: { options, currentValue } })
                return
            }
        }
        if (key === 'goal' && isObject(value)) {
            const goal: DshStateSnapshot['goal'] = {
                id: asString(value.id),
                objective: asString(value.objective),
                ...(typeof value.status === 'string' ? { status: normalizeGoalStatus(value.status) } : {}),
                ...(typeof value.maxGoalRounds === 'number' ? { maxGoalRounds: value.maxGoalRounds } : {}),
                ...(typeof value.currentRound === 'number' ? { currentRound: value.currentRound } : {}),
                ...(typeof value.revision === 'number' ? { revision: value.revision } : {})
            }
            this.emitState({ seq, goal })
            return
        }
        if ((key === 'sessionTitle' || key === 'title') && typeof value === 'string') {
            this.emitState({ seq, title: value })
            return
        }
        // Other projection keys (stats, deliverables, plan, …): persist as a
        // native record so no projection is ever lost.
        const native: DshNativeEvent = {
            seq,
            type: `projection/${key}`,
            time: Date.now(),
            data: { key, value },
            dshSessionId: this.options.dshSessionId
        }
        this.options.onMessage({ type: 'dsh_native', event: native, dshSeq: seq })
    }

    private emitState(patch: Partial<DshStateSnapshot>): void {
        const snapshot = this.projector.foldState(patch)
        this.options.onStateSnapshot(snapshot)
    }

    private seqOf(): number {
        return this.projector.stateSnapshot().seq
    }

    private approvals: DshPendingApproval[] = []
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeGoalStatus(status: string): NonNullable<DshStateSnapshot['goal']>['status'] {
    if (status === 'active' || status === 'paused' || status === 'complete' || status === 'cleared') {
        return status
    }
    return undefined
}
