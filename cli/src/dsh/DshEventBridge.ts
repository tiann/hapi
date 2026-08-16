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
    /** Last forwarded native seq from a previous process (metadata cursor). */
    initialCursor?: number
    /** Forward one projected agent message (text/tool/usage/native/state…). */
    onMessage: (message: DshProjectedMessage, source: 'live' | 'backfill') => void
    /** Called once the first generation attached and its initial backfill
     *  completed (root subscribed + gap released). Session orchestration uses
     *  this to gate session-ready and prompt dispatch. */
    onReady?: () => void
    /** Persisted per-child cursor map (survives CLI restarts so subagent
     *  journals are never replayed into a fresh HAPI row). */
    initialChildCursors?: Record<string, number>
    /** Forwarded native seq for one child session (durable journal cursor). */
    onChildCursor?: (childSessionId: string, seq: number) => void
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
    /** Highest forwarded native seq per child session (subagent reconnect gap-fill anchor). */
    private readonly childLastSeq = new Map<string, number>()
    /** Live child events buffered while that child's history replay is in flight. */
    private readonly childBuffers = new Map<string, Array<import('@deepseek-ai/dsh-session/types').SessionEvent>>()
    /** True while journal recovery (root history + child replays) runs: ANY
     *  child event (known or not) is buffered so its cursor can never advance
     *  past the outage gap. */
    private journalRecoveryInFlight = false
    /** Children whose replay finished: their buffers were released, so their
     *  live events must forward even while other children are still being
     *  replayed (otherwise they re-seal into a buffer nothing ever drains). */
    private readonly childRecoveryReleased = new Set<string>()
    /** Highest forwarded seq per projection key — stale bootstrap responses
     *  (older than a live frame already forwarded) are dropped. */
    private readonly projectionSeqByKey = new Map<string, number>()


    async start(signal: AbortSignal): Promise<void> {
        // Reconnect loop: EITHER stream closing ends the generation (a dead
        // socket must not wait on the other), then backfill the gap since the
        // last forwarded seq and re-open both streams. Each generation gets
        // its own AbortController so the loser of the race is torn down.
        // Persistent failures back off so a dead host cannot spin the CPU.
        let retryMs = 500
        let initialBackfillDone = false
        while (!signal.aborted) {
            const generation = new AbortController()
            const onOuterAbort = () => generation.abort()
            signal.addEventListener('abort', onOuterAbort, { once: true })
            const mux = this.options.client.muxStream(generation.signal)
            const host = this.options.client.hostStream(generation.signal)
            // Seal EVERY child journal BEFORE the pumps dispatch frames:
            // queued frames flushed on reconnect can arrive before the root
            // subscription resolves the attached race.
            if (!initialBackfillDone) {
                this.journalRecoveryInFlight = true
            }
            // Backfill must not start before the root mux subscription is
            // active: events committed between the history response and the
            // subscription would be returned by neither path.
            let resolveSubscribed: (() => void) | undefined
            const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve })
            const muxDone = this.pumpMux(mux, generation.signal, () => resolveSubscribed?.())
            const hostDone = this.pumpHost(host, generation.signal)
            const attached = await Promise.race([
                subscribed.then(() => true),
                muxDone.then(() => false),
                hostDone.then(() => false)
            ])
            if (!attached) {
                generation.abort()
                await Promise.allSettled([muxDone, hostDone])
                signal.removeEventListener('abort', onOuterAbort)
                await waitForAbortableDelay(retryMs, signal)
                retryMs = Math.min(retryMs * 2, 5_000)
                continue
            }
            // First generation: a freshly spawned host sends a subscribed
            // baseline, not historical events — backfill the gap since the
            // last persisted cursor so events committed before the previous
            // process died are projected without waiting for a disconnect.
            // A failed backfill aborts the generation and retries: releasing
            // buffered live events first would advance lastForwardedSeq past
            // the missing range, which a later reconnect could never recover.
            if (!initialBackfillDone) {
                const backfilled = await this.backfillAfterCursor()
                if (!backfilled) {
                    this.journalRecoveryInFlight = false
                    generation.abort()
                    await Promise.allSettled([muxDone, hostDone])
                    signal.removeEventListener('abort', onOuterAbort)
                    await waitForAbortableDelay(retryMs, signal)
                    retryMs = Math.min(retryMs * 2, 5_000)
                    continue
                }
                initialBackfillDone = true
                this.options.onReady?.()
                // Subagent journals are separate from root history; close any
                // gap left by the outage before resuming live forwarding. A
                // failed child replay aborts the generation and reconnects
                // (buffers stay sealed; the retry re-runs the full gap).
                const childBackfilled = await this.backfillChildJournals()
                if (!childBackfilled) {
                    // Re-run the WHOLE initial recovery on the next generation:
                    // reset the flag (root backfill re-seals journals) and
                    // keep initialRootEvents buffered until recovery succeeds.
                    this.journalRecoveryInFlight = false
                    initialBackfillDone = false
                    generation.abort()
                    await Promise.allSettled([muxDone, hostDone])
                    signal.removeEventListener('abort', onOuterAbort)
                    await waitForAbortableDelay(retryMs, signal)
                    retryMs = Math.min(retryMs * 2, 5_000)
                    continue
                }
                this.journalRecoveryInFlight = false
                // Replay live events that arrived while the backfill ran,
                // oldest first; handleSessionEvent's seq guard skips any
                // already forwarded by the backfill itself.
                const buffered = this.initialRootEvents ?? []
                this.initialRootEvents = null
                buffered
                    .sort((a, b) => a.seq - b.seq)
                    .forEach((event) => this.handleSessionEvent(this.options.dshSessionId, event))
            }
            try {
                await Promise.race([muxDone, hostDone])
            } catch (raceError) {
                // A transport-level rejection must not escape the reconnect
                // loop — treat it as a stream end and reconnect.
                logger.warn(`[${this.logTag}] stream pump error: ${raceError instanceof Error ? raceError.message : String(raceError)}`)
            }
            generation.abort()
            await Promise.allSettled([muxDone, hostDone])
            signal.removeEventListener('abort', onOuterAbort)
            if (signal.aborted) break
            logger.debug(`[${this.logTag}] streams closed; reconnecting after seq ${this.lastForwardedSeq}`)
            retryMs = 500
            // Reconnect goes through the SAME generation-safe path as the
            // first generation: streams attach first, live root events are
            // buffered, and only a successful backfill releases them. Fetching
            // history while no stream is attached could skip events committed
            // between the fetch and resubscription, and a failed fetch would
            // leave a permanent hole once a live event advances the cursor.
            initialBackfillDone = false
            this.initialRootEvents = []
            this.childRecoveryReleased.clear()
            // The host re-seeds subscribed + projection baseline on reconnect,
            // so allow re-seeding on the new generation too.
            this.projectionsSeeded = false
            // Exponential backoff up to 5s before the next connect attempt.
            await waitForAbortableDelay(retryMs, signal)
            retryMs = Math.min(retryMs * 2, 5_000)
        }
    }

    /** Highest native seq already forwarded (dedupe + gap-fill anchor). */
    private lastForwardedSeq: number

    constructor(private readonly options: DshEventBridgeOptions) {
        this.projector = options.projector
        this.logTag = options.logTag ?? 'dsh'
        this.lastForwardedSeq = options.initialCursor ?? -1
        this.initialRootEvents = []
        for (const [childId, seq] of Object.entries(options.initialChildCursors ?? {})) {
            this.childLastSeq.set(childId, seq)
        }
    }

    /** Root session/event frames arriving while the initial history backfill
     *  is in flight are buffered here and replayed (seq-sorted) afterwards;
     *  without this, a live event advancing lastForwardedSeq would make the
     *  replay discard older missing events as already forwarded. */
    private initialRootEvents: SessionEvent[] | null = []

    /**
     * Replay native events after the last forwarded seq from session.history.
     *
     * History pages go backwards (beforeSeq = older); the cursor must not
     * advance while older pages are still being read, otherwise the filter
     * would skip them. Collect every page first (walking back until a page
     * contains the cursor), then replay the collected events in order.
     */
    private async backfillAfterCursor(): Promise<boolean> {
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
                return false
            }
            collected.push(...events)
            const reachedAnchor = events.some((event) => event.seq <= anchor)
            if (!hasMore || reachedAnchor) break
            // An empty page with hasMore=true would never advance beforeSeq —
            // bail out instead of spinning forever.
            if (events.length === 0) break
            const oldest = events.reduce((min, event) => Math.min(min, event.seq), Number.MAX_SAFE_INTEGER)
            beforeSeq = oldest
        }
        collected
            .filter((event) => event.seq > anchor)
            .sort((a, b) => a.seq - b.seq)
            .forEach((event) => {
                if (event.seq <= this.lastForwardedSeq) return
                this.handleSessionEvent(this.options.dshSessionId, event, 'backfill')
            })
        return true
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
        // All attempts failed: allow a later session/subscribed (e.g. after a
        // reconnect) to retry the bootstrap instead of staying unseeded.
        this.projectionsSeeded = false
    }

    private async pumpMux(
        mux: AsyncIterable<RpcRequest<MuxFrame>>,
        signal: AbortSignal,
        onRootSubscribed?: () => void
    ): Promise<void> {
        for await (const envelope of mux) {
            if (signal.aborted) return
            const frame = envelope.payload
            if (frame.type === 'session/subscribed'
                && frame.sessionId === this.options.dshSessionId) {
                onRootSubscribed?.()
            }
            try {
                this.handleMuxFrame(frame, envelope.rpcId)
            } catch (error) {
                logger.warn(`[${this.logTag}] mux frame handler error: ${error instanceof Error ? error.message : String(error)}`)
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
                logger.warn(`[${this.logTag}] host frame handler error: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }

    private handleMuxFrame(frame: MuxFrame, rpcId: string): void {
        // Subagent sessions carry their own approval/question/queue/jobs
        // frames; those must never mutate the root session's state.
        if ('sessionId' in frame && frame.sessionId !== undefined && frame.sessionId !== this.options.dshSessionId) {
            if (frame.type === 'approval/requested'
                || frame.type === 'approval/resolved'
                || frame.type === 'question/requested'
                || frame.type === 'question/resolved'
                || frame.type === 'session/queue'
                || frame.type === 'session/jobs'
                || frame.type === 'session/projection') {
                return
            }
        }
        switch (frame.type) {
            case 'session/event': {
                if (frame.sessionId === this.options.dshSessionId && this.initialRootEvents) {
                    this.initialRootEvents.push(frame.event)
                    break
                }
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
                // Null is the durable "no pending question" value and does
                // not render an empty blocking dialog.
                this.emitState({ seq: this.seqOf(), questions: null })
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
    /** Highest seq ever emitted in a dsh_state snapshot: the web compares
     *  whole snapshots, so a bootstrap projection carrying an older asOfSeq
     *  must never regress the overall sequence (its per-key content is
     *  already guarded by projectionSeqByKey). */
    private lastStateSeq = 0

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
                    // A reconnect re-seed may re-emit session-added for an
                    // already-tracked child; keep the existing projector (and
                    // its fold) instead of resetting it.
                    if (!this.childProjectors.has(frame.sessionId)) {
                        this.childProjectors.set(frame.sessionId, new DshProjector(frame.sessionId))
                    }
                    this.subagentIds.add(frame.sessionId)
                    this.emitSubagentCount(this.seqOf())
                }
                break
            }
            case 'host/session-removed': {
                this.childProjectors.delete(frame.sessionId)
                this.childLastSeq.delete(frame.sessionId)
                this.childBuffers.delete(frame.sessionId)
                this.childRecoveryReleased.delete(frame.sessionId)
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

    private handleSessionEvent(sessionId: string, event: SessionEvent, source: 'live' | 'backfill' = 'live', forceForward = false): void {
        if (sessionId === this.options.dshSessionId) {
            if (event.seq <= this.lastForwardedSeq) return
            this.lastForwardedSeq = event.seq
            this.projector.markSeq(event.seq)
            for (const message of this.projector.onEvent(event)) {
                try {
                    this.options.onMessage(message, source)
                } catch (error) {
                    // A consumer failure (e.g. sendAgentMessage on a closing
                    // session) must not wedge the pump; the seq is already
                    // consumed from the stream either way.
                    logger.warn(`[${this.logTag}] onMessage consumer error: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
            this.options.onCursor?.(event.seq)
            return
        }
        // Subagent child events: persist natively under the child's session id
        // so subagent activity survives replay without flattening. While that
        // child's history replay is in flight, buffer instead of forwarding —
        // advancing the cursor mid-fetch would let the replay discard the gap.
        const childBuffer = this.childBuffers.get(sessionId)
        if (!forceForward && (childBuffer || (this.journalRecoveryInFlight && !this.childRecoveryReleased.has(sessionId)))) {
            // Dynamic seal for children first seen during journal recovery.
            const buffer = childBuffer ?? []
            buffer.push(event)
            this.childBuffers.set(sessionId, buffer)
            return
        }
        const seenChildSeq = this.childLastSeq.get(sessionId) ?? -1
        if (event.seq <= seenChildSeq) return
        this.childLastSeq.set(sessionId, event.seq)
        this.options.onChildCursor?.(sessionId, event.seq)
        let child = this.childProjectors.get(sessionId)
        if (!child) {
            child = new DshProjector(sessionId)
            this.childProjectors.set(sessionId, child)
        }
        child.markSeq(event.seq)
        for (const message of child.onEvent(event)) {
            if (message.type === 'dsh_native' || message.type === 'turn_complete' || message.type === 'error') {
                try {
                    this.options.onMessage(message, source)
                } catch (error) {
                    logger.warn(`[${this.logTag}] child onMessage consumer error: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        }
    }

    /** Gap-fill every subagent journal after a reconnect: child events are
     *  NOT part of root session.history, so without this any child activity
     *  during a mux outage would be permanently missing from the durable
     *  dsh_native journal. Children created entirely during the outage are
     *  discovered via subagent.list (which also carries each child's mode). */
    private async backfillChildJournals(): Promise<boolean> {
        const known = new Map<string, 'one-shot' | 'continuable'>()
        for (const childSessionId of this.childLastSeq.keys()) {
            known.set(childSessionId, 'continuable')
        }
        // Children sealed during recovery but not yet in childLastSeq must
        // still be replayed — otherwise their buffers never release.
        for (const childSessionId of this.childBuffers.keys()) {
            known.set(childSessionId, 'continuable')
        }
        try {
            const discovered = await this.options.client.subagentList(this.options.dshSessionId)
            for (const child of discovered) {
                known.set(child.id, child.mode)
            }
        } catch (error) {
            // Children created during the outage may be unknown to us AND
            // absent from the buffers — a failed discovery would permanently
            // skip their journals. Retry the whole recovery instead.
            logger.warn(`[${this.logTag}] subagent discovery failed: ${error instanceof Error ? error.message : String(error)}`)
            return false
        }
        for (const [childSessionId, mode] of known) {
            const anchor = this.childLastSeq.get(childSessionId) ?? -1
            // Buffer live frames for this child while its replay is in flight
            // (advancing the cursor mid-fetch would discard the gap). Merge —
            // never overwrite — a buffer sealed by a previous generation.
            this.childBuffers.set(childSessionId, this.childBuffers.get(childSessionId) ?? [])
            const collected: Array<import('@deepseek-ai/dsh-session/types').SessionEvent> = []
            let beforeSeq: number | undefined
            let attemptMode: 'continuable' | 'one-shot' = mode
            while (true) {
                let events: Array<import('@deepseek-ai/dsh-session/types').SessionEvent> = []
                let hasMore = false
                try {
                    const pageResult = await this.options.client.subagentHistory({
                        parentSessionId: this.options.dshSessionId,
                        childSessionId,
                        mode: attemptMode,
                        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
                        maxMessages: 200
                    })
                    events = pageResult.events.map((entry) => entry.event)
                    hasMore = pageResult.hasMore
                } catch (error) {
                    if (attemptMode === 'continuable') {
                        // Fall back to the one-shot vocabulary once.
                        attemptMode = 'one-shot'
                        continue
                    }
                    logger.debug(`[${this.logTag}] subagent backfill failed for ${childSessionId}: ${error instanceof Error ? error.message : String(error)}`)
                    // Failure: keep this child's buffer sealed and its cursor
                    // untouched. The caller aborts the generation, so the
                    // reconnect retries the whole gap with backoff.
                    return false
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
                    if (event.seq <= (this.childLastSeq.get(childSessionId) ?? -1)) return
                    this.handleSessionEvent(childSessionId, event, 'backfill')
                })
            // Release buffered live frames, oldest first; the seq guard skips
            // anything the replay already forwarded. forceForward bypasses the
            // still-active recovery seal — the buffer is already deleted, so
            // re-buffering would trap these frames forever. The child is then
            // marked released so its FUTURE live events forward too, even
            // while sibling children are still being replayed.
            const buffered = this.childBuffers.get(childSessionId) ?? []
            this.childBuffers.delete(childSessionId)
            this.childRecoveryReleased.add(childSessionId)
            buffered
                .sort((a, b) => a.seq - b.seq)
                .forEach((event) => this.handleSessionEvent(childSessionId, event, 'live', true))
        }
        return true
    }

    private handleProjection(key: string, value: unknown, seq: number): void {
        // Drop projections older than the newest already forwarded for this
        // key: a stale bootstrap history response must never overwrite a
        // newer live frame (and later unrelated patches must not republish
        // it at a newer sequence).
        const previousSeq = this.projectionSeqByKey.get(key) ?? -1
        if (seq < previousSeq) {
            return
        }
        this.projectionSeqByKey.set(key, seq)
        if (key === 'permissions' && isObject(value)) {
            const options = Array.isArray(value.options)
                ? value.options
                    .filter((o): o is Record<string, unknown> => isObject(o))
                    .map((o) => {
                        const description = asString(o.description)
                        return {
                            value: asString(o.value) ?? '',
                            name: asString(o.name) ?? asString(o.value) ?? '',
                            ...(description !== undefined ? { description } : {})
                        }
                    })
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
        this.options.onMessage({ type: 'dsh_native', event: native, dshSeq: seq }, 'live')
    }

    private emitState(patch: Partial<DshStateSnapshot>): void {
        if (typeof patch.seq === 'number' && patch.seq > this.lastStateSeq) {
            this.lastStateSeq = patch.seq
        }
        const snapshot = this.projector.foldState({
            ...patch,
            ...(typeof patch.seq === 'number' ? { seq: this.lastStateSeq } : {})
        })
        this.options.onStateSnapshot(snapshot)
    }

    private seqOf(): number {
        return this.projector.stateSnapshot().seq
    }

    private approvals: DshPendingApproval[] = []
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
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
