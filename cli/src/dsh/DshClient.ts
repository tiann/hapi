import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
    HistoryEntry,
    ModelSelection,
    PromptContentPart,
    SessionModels,
    SessionProjectionsBlock,
    SessionSummary
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { DshNodeTransport } from './DshNodeTransport'

/** Business RPC failure with the official error code + message. */
export class DshRpcError extends Error {
    readonly code: string
    readonly details: unknown

    constructor(code: string, message: string, details?: unknown) {
        super(message)
        this.name = 'DshRpcError'
        this.code = code
        this.details = details
    }
}

export type DshSessionCreateResult = {
    sessionId: string
    agentPreset?: string
}

export type DshHistoryPage = {
    events: HistoryEntry[]
    hasMore: boolean
    projections?: SessionProjectionsBlock
}

export type DshPromptResult = {
    accepted: true
    command?: { kind: 'success'; text?: string }
    /** The rpcId this prompt was dispatched under; the host echoes it in the
     *  user/message event's MessageSource so the client can reconcile the
     *  HAPI row with the native event (fork/rewind anchors). */
    rpcId: string
}

export type DshModelSelectionResult = {
    selected: ModelSelection
}

/**
 * Typed client over the official DSH apiproxy wire contract. Unary methods
 * unwrap the RPC envelope and throw {@link DshRpcError} on business failure;
 * stream methods expose the raw frame iterables for the event bridge.
 *
 * This is the only HAPI-side consumer of the official wire client types.
 */
export class DshClient {
    constructor(
        private readonly api: IApiClient,
        private readonly baseUrl: string
    ) {}

    static connect(baseUrl: string): DshClient {
        return new DshClient(new DshNodeTransport(baseUrl), baseUrl)
    }

    /** The underlying wire client (exposed for stream access + diagnostics). */
    get wire(): IApiClient {
        return this.api
    }

    async describe(): Promise<ResponseValue<'host.describe'>> {
        const response = await this.api.host.describe({})
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async listSessions(): Promise<SessionSummary[]> {
        const response = await this.api.sessions.list({})
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value.items
    }

    /**
     * Create (or idempotently resume) a session. Preallocating `sessionId`
     * makes retries with the same id + cwd return the same session; a
     * different cwd fails with `session-conflict`.
     */
    async createSession(options: {
        cwd?: string
        sessionId?: string
        agentPreset?: string
    }): Promise<DshSessionCreateResult> {
        const response = await this.api.sessions.create({
            cwd: options.cwd,
            agentPreset: options.agentPreset,
            ...(options.sessionId ? { sessionId: SessionId(options.sessionId) } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async sessionHistory(options: {
        sessionId: string
        beforeSeq?: number
        maxMessages?: number
    }): Promise<DshHistoryPage> {
        const response = await this.api.sessions.history({
            sessionId: SessionId(options.sessionId),
            ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
            ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async subagentHistory(options: {
        parentSessionId: string
        childSessionId: string
        mode: 'one-shot' | 'continuable'
        beforeSeq?: number
        maxMessages?: number
    }): Promise<DshHistoryPage> {
        const response = await this.api.subagents.history({
            parentSessionId: SessionId(options.parentSessionId),
            childSessionId: SessionId(options.childSessionId),
            mode: options.mode,
            ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
            ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async sessionModels(sessionId: string): Promise<SessionModels> {
        const response = await this.api.sessions.models({ sessionId: SessionId(sessionId) })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async selectModel(options: {
        sessionId: string
        provider: string
        model: string
        reasoningEffort?: string
    }): Promise<DshModelSelectionResult> {
        const response = await this.api.sessions.selectModel({
            sessionId: SessionId(options.sessionId),
            provider: options.provider,
            model: options.model,
            ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async prompt(options: {
        sessionId: string
        mode: 'queue' | 'steer'
        content: PromptContentPart[]
        clientTimeZone?: string
    }): Promise<DshPromptResult> {
        const response = await this.api.sessions.prompt({
            sessionId: SessionId(options.sessionId),
            mode: options.mode,
            content: options.content,
            ...(options.clientTimeZone !== undefined ? { clientTimeZone: options.clientTimeZone } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return { ...response.result.value, rpcId: response.rpcId }
    }

    async cancel(sessionId: string): Promise<void> {
        const response = await this.api.sessions.cancel({ sessionId: SessionId(sessionId) })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
    }

    async updateQueueAction(options: {
        sessionId: string
        itemId: string
        action: { kind: 'edit'; content: Array<{ type: 'text'; text: string }> } | { kind: 'remove' } | { kind: 'steer' }
    }): Promise<void> {
        const response = await this.api.sessions.updateQueue({
            sessionId: SessionId(options.sessionId),
            itemId: options.itemId as never,
            action: options.action as never
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
    }

    async forkSession(options: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
        const response = await this.api.sessions.fork({
            sessionId: SessionId(options.sessionId),
            ...(options.atSeq !== undefined ? { atSeq: options.atSeq } : {})
        })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async listSkills(sessionId: ReturnType<typeof SessionId>): Promise<ResponseValue<'skill.list'>> {
        const response = await this.api.skills.list({ sessionId })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async listAgentPresets(): Promise<ResponseValue<'agentPreset.list'>> {
        const response = await this.api.agentPresets.list({})
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    async selectAgentPreset(sessionId: ReturnType<typeof SessionId>, agentPreset: string): Promise<{ agentPreset: string }> {
        const response = await this.api.agentPresets.select({ sessionId, agentPreset })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value
    }

    /** Unwrapped goal-domain call (create/edit/pause/resume/complete/clear). */
    async goalCall<M extends 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear'>(
        method: M,
        payload: unknown
    ): Promise<unknown> {
        const response = await this.api.goals[method](payload as never)
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value as unknown
    }

    /** Unwrapped subagent-domain call (list/history/prompt/interrupt). */
    async subagentCall<M extends 'list' | 'history' | 'prompt' | 'interrupt'>(
        method: M,
        payload: unknown
    ): Promise<unknown> {
        const response = await this.api.subagents[method](payload as never)
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
        return response.result.value as unknown
    }

    goals = {
        create: (payload: { sessionId: ReturnType<typeof SessionId>; objective: string; maxGoalRounds?: number }) =>
            this.goalCall('create', payload),
        edit: (payload: { sessionId: ReturnType<typeof SessionId>; ref: { id: string; revision: number }; objective?: string; maxGoalRounds?: number }) =>
            this.goalCall('edit', payload),
        pause: (payload: { sessionId: ReturnType<typeof SessionId>; ref: { id: string; revision: number } }) =>
            this.goalCall('pause', payload),
        resume: (payload: { sessionId: ReturnType<typeof SessionId>; ref: { id: string; revision: number } }) =>
            this.goalCall('resume', payload),
        complete: (payload: { sessionId: ReturnType<typeof SessionId>; ref: { id: string; revision: number } }) =>
            this.goalCall('complete', payload),
        clear: (payload: { sessionId: ReturnType<typeof SessionId>; ref: { id: string; revision: number } }) =>
            this.goalCall('clear', payload)
    }

    subagents = {
        list: (payload: { parentSessionId: ReturnType<typeof SessionId> }) => this.subagentCall('list', payload),
        history: (payload: {
            parentSessionId: ReturnType<typeof SessionId>
            childSessionId: string
            mode: 'one-shot' | 'continuable'
            beforeSeq?: number
            maxMessages?: number
        }) => this.subagentCall('history', payload),
        prompt: (payload: {
            parentSessionId: ReturnType<typeof SessionId>
            childSessionId: string
            mode: 'one-shot' | 'continuable'
            content: Array<{ type: 'text'; text: string }>
        }) => this.subagentCall('prompt', payload),
        interrupt: (payload: {
            parentSessionId: ReturnType<typeof SessionId>
            childSessionId: string
            mode: 'one-shot' | 'continuable'
        }) => this.subagentCall('interrupt', payload)
    }

    /** All-session aggregated event stream (raw frames, ordered per session). */
    muxStream(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
        return this.api.events.mux({}, signal)
    }

    /** Host-level info stream (session create/destroy, status flips, agent errors). */
    hostStream(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> {
        return this.api.events.host({}, signal)
    }

    /**
     * Answer a server-request frame (approval/question) by echoing its rpcId.
     * `value` is the domain payload (ApprovalResponsePayload /
     * QuestionResponsePayload).
     */
    async respond(rpcId: string, value: unknown): Promise<void> {
        await this.api.respond({
            type: 'client-response',
            rpcId: rpcId as never,
            result: { ok: true, value }
        })
    }

    /**
     * Call a Typert Gateway endpoint on the shared /api channel (e.g.
     * messageFeedback/put). These endpoints are not part of the unary
     * ApiProxy surface, so they bypass callUnary's value-schema table and use
     * the raw envelope directly — the same wire the official web client uses
     * for ctx.remote.* namespaces.
     */
    async gatewayCall<T = unknown>(endpoint: string, payload: unknown): Promise<T> {
        const transport = this.api as unknown as { doFetch(input: URL, init?: RequestInit): Promise<Response> }
        const response = await transport.doFetch(new URL(`/api/${endpoint}`, this.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'client-request',
                rpcId: crypto.randomUUID(),
                method: endpoint,
                payload
            })
        })
        if (!response.ok) {
            throw new DshRpcError('transport', `gateway ${endpoint}: HTTP ${response.status}`)
        }
        const parsed = await response.json() as { type: string; result?: { ok: boolean; value?: unknown; error?: { code: string; message: string; details?: unknown } } }
        if (!parsed.result?.ok) {
            const error = parsed.result?.error
            throw new DshRpcError(error?.code ?? 'internal', error?.message ?? `gateway ${endpoint} failed`, error?.details)
        }
        return parsed.result.value as T
    }
}
