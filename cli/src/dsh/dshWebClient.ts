import { randomUUID } from 'node:crypto'

type JsonRecord = Record<string, unknown>

export type DshSessionEvent = {
    type: string
    seq: number
    time: number
    data: unknown
    sourceEventSeqs?: number[]
    surfaceOp?: unknown
    ignorable?: true
}

export type DshHistoryEntry = {
    event: DshSessionEvent
    view?: unknown
}

export type DshSessionSummary = {
    sessionId: string
    updatedAt: number
    running: boolean
    blank: boolean
    parentSessionId?: string
    origin?: 'subagent'
    cwd?: string
    agentPreset?: string
    projections?: {
        asOfSeq: number
        values: Record<string, unknown>
    }
}

export type DshMuxFrame = {
    type: string
    sessionId?: string
    event?: DshSessionEvent
    [key: string]: unknown
}

export type DshServerRequest = {
    type: 'server-request'
    rpcId: string
    method: string
    payload: DshMuxFrame
}

export type DshModelSelection = {
    provider: string
    model: string
    reasoningEffort?: string
}

export type DshModelSummary = {
    provider: string
    providerName: string
    model: string
    name: string
    reasoningEfforts: Array<{ id: string; name: string; isDefault: boolean }>
}

export class DshWebRpcError extends Error {
    constructor(
        readonly method: string,
        readonly code: string,
        message: string,
        readonly details?: unknown
    ) {
        super(`DeepSeek Harness ${method} failed: ${message}`)
        this.name = 'DshWebRpcError'
    }
}

export function resolveDshWebUrl(value = process.env.HAPI_DSH_URL): string {
    const candidate = value?.trim() || 'http://127.0.0.1:3080'
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('HAPI_DSH_URL must use http:// or https://')
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('HAPI_DSH_URL must not contain credentials, query parameters, or a fragment')
    }
    url.pathname = '/'
    return url.origin
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseSessionEvent(value: unknown): DshSessionEvent | null {
    if (!isRecord(value)) return null
    const type = asString(value.type)
    const seq = asNumber(value.seq)
    const time = asNumber(value.time)
    if (!type || seq === null || time === null || seq < 0) return null
    return {
        type,
        seq,
        time,
        data: value.data,
        ...(Array.isArray(value.sourceEventSeqs)
            ? { sourceEventSeqs: value.sourceEventSeqs.filter((entry): entry is number => typeof entry === 'number') }
            : {}),
        ...(value.surfaceOp !== undefined ? { surfaceOp: value.surfaceOp } : {}),
        ...(value.ignorable === true ? { ignorable: true } : {})
    }
}

function parseSessionSummary(value: unknown): DshSessionSummary | null {
    if (!isRecord(value)) return null
    const sessionId = asString(value.sessionId)
    const updatedAt = asNumber(value.updatedAt)
    if (!sessionId || updatedAt === null || typeof value.running !== 'boolean' || typeof value.blank !== 'boolean') {
        return null
    }
    const projections = isRecord(value.projections)
        && asNumber(value.projections.asOfSeq) !== null
        && isRecord(value.projections.values)
        ? {
            asOfSeq: value.projections.asOfSeq as number,
            values: value.projections.values
        }
        : undefined
    return {
        sessionId,
        updatedAt,
        running: value.running,
        blank: value.blank,
        ...(asString(value.parentSessionId) ? { parentSessionId: value.parentSessionId as string } : {}),
        ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(asString(value.cwd) ? { cwd: value.cwd as string } : {}),
        ...(asString(value.agentPreset) ? { agentPreset: value.agentPreset as string } : {}),
        ...(projections ? { projections } : {})
    }
}

export class DshWebClient {
    readonly baseUrl: string

    constructor(
        baseUrl = resolveDshWebUrl(),
        private readonly fetchImpl: typeof fetch = fetch
    ) {
        this.baseUrl = resolveDshWebUrl(baseUrl)
    }

    async describe(signal?: AbortSignal): Promise<{
        version: string
        cwd: string
        provider: string
        model: string
        attachedSessions: number
    }> {
        const { value } = await this.call('host.describe', {}, signal)
        if (!isRecord(value)) throw new Error('DeepSeek Harness host.describe returned an invalid value')
        const version = asString(value.version)
        const cwd = asString(value.cwd)
        const provider = asString(value.provider)
        const model = asString(value.model)
        const attachedSessions = asNumber(value.attachedSessions)
        if (!version || !cwd || !provider || !model || attachedSessions === null) {
            throw new Error('DeepSeek Harness host.describe is missing required fields')
        }
        return { version, cwd, provider, model, attachedSessions }
    }

    async listSessions(signal?: AbortSignal): Promise<DshSessionSummary[]> {
        const { value } = await this.call('session.list', {}, signal)
        if (!isRecord(value) || !Array.isArray(value.items)) {
            throw new Error('DeepSeek Harness session.list returned an invalid value')
        }
        const sessions = value.items.map(parseSessionSummary)
        if (sessions.some((entry) => entry === null)) {
            throw new Error('DeepSeek Harness session.list returned an invalid session row')
        }
        return sessions as DshSessionSummary[]
    }

    async getHistory(options: {
        sessionId: string
        beforeSeq?: number
        maxMessages?: number
        signal?: AbortSignal
    }): Promise<{ entries: DshHistoryEntry[]; hasMore: boolean; projections?: { asOfSeq: number; values: Record<string, unknown> } }> {
        const payload = {
            sessionId: options.sessionId,
            ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
            ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {})
        }
        const { value } = await this.call('session.history', payload, options.signal, 120_000)
        if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') {
            throw new Error('DeepSeek Harness session.history returned an invalid value')
        }
        const entries: DshHistoryEntry[] = []
        for (const raw of value.events) {
            if (!isRecord(raw)) throw new Error('DeepSeek Harness session.history returned an invalid entry')
            const event = parseSessionEvent(raw.event)
            if (!event) throw new Error('DeepSeek Harness session.history returned an invalid event')
            entries.push({ event, ...(raw.view !== undefined ? { view: raw.view } : {}) })
        }
        const projections = isRecord(value.projections)
            && asNumber(value.projections.asOfSeq) !== null
            && isRecord(value.projections.values)
            ? { asOfSeq: value.projections.asOfSeq as number, values: value.projections.values }
            : undefined
        return { entries, hasMore: value.hasMore, ...(projections ? { projections } : {}) }
    }

    async createSession(options: { cwd: string; agentPreset?: string }, signal?: AbortSignal): Promise<string> {
        const { value } = await this.call('session.create', options, signal)
        if (!isRecord(value) || !asString(value.sessionId)) {
            throw new Error('DeepSeek Harness session.create returned an invalid session id')
        }
        return value.sessionId as string
    }

    async prompt(options: {
        sessionId: string
        text: string
        mode?: 'queue' | 'steer'
        clientTimeZone?: string
        rpcId?: string
        signal?: AbortSignal
    }): Promise<{ rpcId: string; command?: { text?: string } }> {
        const { rpcId, value } = await this.call('session.prompt', {
            sessionId: options.sessionId,
            mode: options.mode ?? 'queue',
            content: [{ type: 'text', text: options.text }],
            ...(options.clientTimeZone ? { clientTimeZone: options.clientTimeZone } : {})
        }, options.signal, 120_000, options.rpcId)
        if (!isRecord(value) || value.accepted !== true) {
            throw new Error('DeepSeek Harness session.prompt was not accepted')
        }
        const command = isRecord(value.command) && value.command.kind === 'success'
            ? { ...(typeof value.command.text === 'string' ? { text: value.command.text } : {}) }
            : undefined
        return { rpcId, ...(command ? { command } : {}) }
    }

    async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
        const { value } = await this.call('session.cancel', { sessionId }, signal)
        if (!isRecord(value) || value.accepted !== true) {
            throw new Error('DeepSeek Harness session.cancel was not accepted')
        }
    }

    async getModels(sessionId: string, signal?: AbortSignal): Promise<{
        current: DshModelSelection
        models: DshModelSummary[]
    }> {
        const { value } = await this.call('session.models', { sessionId }, signal)
        if (!isRecord(value) || !isRecord(value.current) || !Array.isArray(value.groups)) {
            throw new Error('DeepSeek Harness session.models returned an invalid value')
        }
        const provider = asString(value.current.provider)
        const model = asString(value.current.model)
        if (!provider || !model) {
            throw new Error('DeepSeek Harness session.models is missing the current model')
        }

        const models: DshModelSummary[] = []
        for (const rawGroup of value.groups) {
            if (!isRecord(rawGroup) || !asString(rawGroup.id) || !asString(rawGroup.name) || !Array.isArray(rawGroup.models)) {
                throw new Error('DeepSeek Harness session.models returned an invalid provider group')
            }
            for (const rawModel of rawGroup.models) {
                if (!isRecord(rawModel) || !asString(rawModel.id) || !asString(rawModel.name)) {
                    throw new Error('DeepSeek Harness session.models returned an invalid model')
                }
                const reasoning = isRecord(rawModel.reasoning) ? rawModel.reasoning : null
                const defaultEffort = reasoning ? asString(reasoning.defaultEffort) : null
                const efforts = reasoning && Array.isArray(reasoning.efforts)
                    ? reasoning.efforts.map((rawEffort) => {
                        if (!isRecord(rawEffort) || !asString(rawEffort.id) || !asString(rawEffort.name)) {
                            throw new Error('DeepSeek Harness session.models returned an invalid reasoning effort')
                        }
                        return {
                            id: rawEffort.id as string,
                            name: rawEffort.name as string,
                            isDefault: rawEffort.id === defaultEffort
                        }
                    })
                    : []
                models.push({
                    provider: rawGroup.id as string,
                    providerName: rawGroup.name as string,
                    model: rawModel.id as string,
                    name: rawModel.name as string,
                    reasoningEfforts: efforts
                })
            }
        }

        return {
            current: {
                provider,
                model,
                ...(asString(value.current.reasoningEffort)
                    ? { reasoningEffort: value.current.reasoningEffort as string }
                    : {})
            },
            models
        }
    }

    async selectModel(options: {
        sessionId: string
        provider: string
        model: string
        reasoningEffort?: string
        signal?: AbortSignal
    }): Promise<DshModelSelection> {
        const { value } = await this.call('session.selectModel', {
            sessionId: options.sessionId,
            provider: options.provider,
            model: options.model,
            ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
        }, options.signal)
        const selected = isRecord(value) && isRecord(value.selected) ? value.selected : null
        const provider = selected ? asString(selected.provider) : null
        const model = selected ? asString(selected.model) : null
        if (!selected || !provider || !model) {
            throw new Error('DeepSeek Harness session.selectModel returned an invalid selection')
        }
        return {
            provider,
            model,
            ...(asString(selected.reasoningEffort)
                ? { reasoningEffort: selected.reasoningEffort as string }
                : {})
        }
    }

    async setPermissionPreset(sessionId: string, preset: string, signal?: AbortSignal): Promise<void> {
        await this.prompt({
            sessionId,
            text: `/permission ${preset}`,
            mode: 'queue',
            signal
        })
    }

    async respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<void> {
        await this.sendResponse(rpcId, { ok: true, value }, signal)
    }

    async cancelResponse(rpcId: string, signal?: AbortSignal): Promise<void> {
        await this.sendResponse(rpcId, {
            ok: false,
            error: { code: 'cancelled', message: 'Cancelled by HAPI client' }
        }, signal)
    }

    private async sendResponse(rpcId: string, result: unknown, signal?: AbortSignal): Promise<void> {
        const response = await this.fetchImpl(new URL('/api/respond', this.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'client-response',
                rpcId,
                result
            }),
            signal
        })
        if (!response.ok) throw new Error(`DeepSeek Harness response transport failed: HTTP ${response.status}`)
        const receipt: unknown = await response.json()
        if (!isRecord(receipt) || receipt.accepted !== true) {
            const reason = isRecord(receipt) ? asString(receipt.reason) : null
            throw new Error(`DeepSeek Harness response was rejected${reason ? `: ${reason}` : ''}`)
        }
    }

    subscribeMux(options: {
        signal: AbortSignal
        onFrame: (request: DshServerRequest) => void
        onError?: (error: Error) => void
    }): Promise<void> {
        const url = new URL('/api/events.mux', this.baseUrl)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url.toString())
            let opened = false
            const abort = () => socket.close()
            options.signal.addEventListener('abort', abort, { once: true })
            socket.onopen = () => {
                opened = true
                resolve()
            }
            socket.onmessage = (message) => {
                try {
                    const parsed: unknown = JSON.parse(String(message.data))
                    if (!isRecord(parsed)
                        || parsed.type !== 'server-request'
                        || !asString(parsed.rpcId)
                        || !asString(parsed.method)
                        || !isRecord(parsed.payload)
                        || !asString(parsed.payload.type)) {
                        throw new Error('invalid mux frame')
                    }
                    options.onFrame({
                        type: 'server-request',
                        rpcId: parsed.rpcId as string,
                        method: parsed.method as string,
                        payload: parsed.payload as DshMuxFrame
                    })
                } catch (error) {
                    options.onError?.(error instanceof Error ? error : new Error(String(error)))
                }
            }
            socket.onerror = () => {
                const error = new Error('DeepSeek Harness event stream failed')
                if (!opened) reject(error)
                else options.onError?.(error)
            }
            socket.onclose = () => {
                options.signal.removeEventListener('abort', abort)
                if (!options.signal.aborted) {
                    options.onError?.(new Error('DeepSeek Harness event stream disconnected'))
                }
            }
        })
    }

    private async call(
        method: string,
        payload: unknown,
        signal?: AbortSignal,
        timeoutMs = 30_000,
        requestedRpcId?: string
    ): Promise<{ rpcId: string; value: unknown }> {
        const rpcId = requestedRpcId ?? randomUUID()
        const timeout = AbortSignal.timeout(timeoutMs)
        const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
        let response: Response
        try {
            response = await this.fetchImpl(new URL(`/api/${method}`, this.baseUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
                signal: combined
            })
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(
                `Unable to reach DeepSeek Harness at ${this.baseUrl}. ` +
                `Start it with \`dsh web --port ${new URL(this.baseUrl).port || '3080'}\` or set HAPI_DSH_URL. ${detail}`
            )
        }
        if (!response.ok) throw new Error(`DeepSeek Harness ${method} transport failed: HTTP ${response.status}`)
        const body: unknown = await response.json()
        if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)) {
            throw new Error(`DeepSeek Harness ${method} returned an invalid RPC envelope`)
        }
        if (body.result.ok !== true) {
            const error = isRecord(body.result.error) ? body.result.error : {}
            throw new DshWebRpcError(
                method,
                asString(error.code) ?? 'unknown',
                asString(error.message) ?? 'Unknown error',
                error.details
            )
        }
        return { rpcId, value: body.result.value }
    }
}
