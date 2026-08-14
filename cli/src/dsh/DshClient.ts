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
    constructor(private readonly api: IApiClient) {}

    static connect(baseUrl: string): DshClient {
        return new DshClient(new DshNodeTransport(baseUrl))
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
        return response.result.value
    }

    async cancel(sessionId: string): Promise<void> {
        const response = await this.api.sessions.cancel({ sessionId: SessionId(sessionId) })
        if (!response.result.ok) {
            throw new DshRpcError(response.result.error.code, response.result.error.message, response.result.error.details)
        }
    }

    /** All-session aggregated event stream (raw frames, ordered per session). */
    muxStream(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
        return this.api.events.mux({}, signal)
    }

    /** Host-level info stream (session create/destroy, status flips, agent errors). */
    hostStream(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> {
        return this.api.events.host({}, signal)
    }
}
