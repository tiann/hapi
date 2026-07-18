import { Hono } from 'hono'
import type { DecryptedMessage, Session, SyncEvent } from '@hapi/protocol/types'
import { SSEManager } from '../src/sse/sseManager'
import type { StoredMessage } from '../src/store'
import type { SyncEngine } from '../src/sync/syncEngine'
import {
    readCompleteMessagePage,
    type MessagePageOptions,
    type MessagePageResult,
    type MessagePageStore,
} from '../src/sync/messagePage'
import { VisibilityTracker } from '../src/visibility/visibilityTracker'
import type { WebAppEnv } from '../src/web/middleware/auth'
import { createEventsRoutes } from '../src/web/routes/events'
import { createMessagesRoutes } from '../src/web/routes/messages'

type Scenario = 'tool-dense' | 'history' | 'single-row-history' | 'live-cap' | 'ten-thousand'

type PageRequestRecord = {
    beforeSeq: number | null
    afterSeq: number | null
    limit: number
    responseCount: number
    startComplete: boolean
    endComplete: boolean
}

const SESSION_ID = 'message-window-e2e'
const NAMESPACE = 'e2e'
const DEFAULT_PORT = 4_179

function message(
    id: string,
    seq: number,
    role: 'user' | 'agent',
    content: unknown,
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq,
        content: { role, content },
    }
}

function userMessage(id: string, seq: number, text: string): DecryptedMessage {
    return message(id, seq, 'user', { type: 'text', text })
}

function codexMessage(id: string, seq: number, text: string): DecryptedMessage {
    return message(id, seq, 'agent', {
        type: 'codex',
        data: { type: 'message', message: text },
    })
}

function toolCallMessage(index: number, seq: number): DecryptedMessage {
    return message(`tool-call-row-${index}`, seq, 'agent', {
        type: 'codex',
        data: {
            type: 'tool-call',
            id: `tool-call-row-${index}`,
            callId: `call-${index}`,
            name: 'Bash',
            input: {
                command: `echo pair-${index}`,
                cwd: `pair-${index}-input-sentinel`,
            },
        },
    })
}

function toolResultMessage(index: number, seq: number): DecryptedMessage {
    return message(`tool-result-row-${index}`, seq, 'agent', {
        type: 'codex',
        data: {
            type: 'tool-call-result',
            id: `tool-result-row-${index}`,
            callId: `call-${index}`,
            output: {
                stdout: `pair-${index}-result`,
                exitCode: 0,
                diagnostic: `pair-${index}-result-sentinel`,
            },
            is_error: false,
        },
    })
}

function createToolDenseMessages(): DecryptedMessage[] {
    const rows = createHistoryMessages()
    const turnStartSeq = (rows.at(-1)?.seq ?? 0) + 1
    rows.push(userMessage('stress-question', turnStartSeq, 'STRESS_QUESTION'))
    for (let index = 0; index < 1_000; index += 1) {
        rows.push(toolCallMessage(index, turnStartSeq + index * 2 + 1))
        rows.push(toolResultMessage(index, turnStartSeq + index * 2 + 2))
    }
    rows.push(codexMessage('stress-final-answer', turnStartSeq + 2_001, 'STRESS_FINAL_ANSWER'))
    return rows
}

function createHistoryMessages(): DecryptedMessage[] {
    return Array.from({ length: 41 }, (_, index) => {
        const turn = index + 1
        const seq = index * 2 + 1
        return [
            userMessage(`history-user-${turn}`, seq, `HISTORY_QUESTION_${turn}`),
            codexMessage(`history-answer-${turn}`, seq + 1, `HISTORY_ANSWER_${turn}`),
        ]
    }).flat()
}

function createSingleRowHistoryMessages(): DecryptedMessage[] {
    return Array.from({ length: 100 }, (_, index) => {
        const turn = index + 1
        return userMessage(`single-row-history-${turn}`, turn, `SINGLE_ROW_HISTORY_${turn}`)
    })
}

function createLiveCapMessages(): DecryptedMessage[] {
    return Array.from({ length: 40 }, (_, index) => {
        const turn = index + 1
        return userMessage(`live-cap-${turn}`, turn, `LIVE_CAP_TURN_${turn}`)
    })
}

function createTenThousandMessages(): DecryptedMessage[] {
    const rows: DecryptedMessage[] = [userMessage('virtual-question', 1, 'VIRTUAL_QUESTION')]
    for (let seq = 2; seq < 10_000; seq += 1) {
        rows.push(codexMessage(`virtual-event-${seq}`, seq, `VIRTUAL_EVENT_${seq}`))
    }
    rows.push(codexMessage('virtual-final', 10_000, 'VIRTUAL_FINAL_10000'))
    return rows
}

function createScenarioMessages(scenario: Scenario): DecryptedMessage[] {
    if (scenario === 'history') return createHistoryMessages()
    if (scenario === 'single-row-history') return createSingleRowHistoryMessages()
    if (scenario === 'live-cap') return createLiveCapMessages()
    if (scenario === 'ten-thousand') return createTenThousandMessages()
    return createToolDenseMessages()
}

function toStoredMessage(row: DecryptedMessage): StoredMessage {
    return {
        id: row.id,
        sessionId: SESSION_ID,
        content: row.content,
        createdAt: row.createdAt,
        seq: row.seq ?? 0,
        localId: row.localId,
    }
}

function boundedLimit(limit: number, options?: { maxLimit?: number }): number {
    const maxLimit = typeof options?.maxLimit === 'number' && Number.isFinite(options.maxLimit)
        ? Math.max(1, Math.trunc(options.maxLimit))
        : 200
    return Number.isFinite(limit)
        ? Math.max(1, Math.min(maxLimit, Math.trunc(limit)))
        : Math.min(200, maxLimit)
}

class MemoryMessagePageStore implements MessagePageStore {
    private rows: StoredMessage[] = []

    reset(messages: DecryptedMessage[]): void {
        this.rows = messages.map(toStoredMessage)
    }

    append(messages: DecryptedMessage[]): void {
        this.rows = [...this.rows, ...messages.map(toStoredMessage)]
    }

    newestSeq(): number {
        return this.rows.at(-1)?.seq ?? 0
    }

    getMessages(
        sessionId: string,
        limit: number,
        beforeSeq?: number,
        options?: { maxLimit?: number },
    ): StoredMessage[] {
        if (sessionId !== SESSION_ID) return []
        const eligible = beforeSeq === undefined
            ? this.rows
            : this.rows.filter((row) => row.seq < beforeSeq)
        return eligible.slice(-boundedLimit(limit, options))
    }

    getMessagesAfter(
        sessionId: string,
        afterSeq: number,
        limit: number,
        options?: { maxLimit?: number },
    ): StoredMessage[] {
        if (sessionId !== SESSION_ID) return []
        return this.rows
            .filter((row) => row.seq > afterSeq)
            .slice(0, boundedLimit(limit, options))
    }
}

const session: Session = {
    id: SESSION_ID,
    namespace: NAMESPACE,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata: {
        path: '/tmp/hapi-message-window-e2e',
        host: 'playwright',
        flavor: 'codex',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 1,
    backgroundTaskCount: 0,
    model: null,
    modelReasoningEffort: null,
    serviceTier: null,
    effort: null,
    permissionMode: 'default',
    collaborationMode: 'default',
}

const store = new MemoryMessagePageStore()
const pageRequests: PageRequestRecord[] = []
let emittedCount = 0
store.reset(createToolDenseMessages())

function getMessagesPage(sessionId: string, options: MessagePageOptions): MessagePageResult {
    const result = readCompleteMessagePage(store, sessionId, options)
    pageRequests.push({
        beforeSeq: options.beforeSeq,
        afterSeq: options.afterSeq,
        limit: result.page.limit,
        responseCount: result.messages.length,
        startComplete: result.page.startComplete,
        endComplete: result.page.endComplete,
    })
    return result
}

const engine = {
    resolveSessionAccess: (sessionId: string, namespace: string) => {
        if (sessionId !== SESSION_ID) {
            return { ok: false as const, reason: 'not-found' as const }
        }
        if (namespace !== NAMESPACE) {
            return { ok: false as const, reason: 'access-denied' as const }
        }
        return { ok: true as const, sessionId: SESSION_ID, session }
    },
    getMessagesPage,
    markSessionRead: () => {},
    getRecentUserMessages: () => [],
    getMachine: () => undefined,
} as unknown as SyncEngine

const visibilityTracker = new VisibilityTracker()
const sseManager = new SSEManager(30_000, visibilityTracker)
const app = new Hono<WebAppEnv>()

app.use('*', async (context, next) => {
    context.set('userId', 1)
    context.set('namespace', NAMESPACE)
    await next()
})

app.get('/api/__e2e/health', (context) => context.json({ ok: true }))

app.get('/api/__e2e/diagnostics', (context) => context.json({
    pageRequests,
    emittedCount,
}))

app.post('/api/__e2e/reset', async (context) => {
    const body = await context.req.json().catch(() => null) as { scenario?: unknown } | null
    const scenario = body?.scenario
    if (
        scenario !== 'tool-dense'
        && scenario !== 'history'
        && scenario !== 'single-row-history'
        && scenario !== 'live-cap'
        && scenario !== 'ten-thousand'
    ) {
        return context.json({ error: 'Invalid scenario' }, 400)
    }
    store.reset(createScenarioMessages(scenario))
    pageRequests.length = 0
    emittedCount = 0
    return context.json({ ok: true })
})

app.post('/api/__e2e/stream', async (context) => {
    const body = await context.req.json().catch(() => null) as {
        count?: unknown
        kind?: unknown
        broadcast?: unknown
    } | null
    const count = body?.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 5_000) {
        return context.json({ error: 'Invalid count' }, 400)
    }
    const kind = body?.kind ?? 'agent-events'
    if (kind !== 'agent-events' && kind !== 'user-turns') {
        return context.json({ error: 'Invalid stream kind' }, 400)
    }
    if (body?.broadcast !== undefined && typeof body.broadcast !== 'boolean') {
        return context.json({ error: 'Invalid broadcast flag' }, 400)
    }
    const shouldBroadcast = body?.broadcast !== false

    const startSeq = store.newestSeq()
    const incoming = Array.from({ length: count }, (_, index) => {
        const seq = startSeq + index + 1
        return kind === 'user-turns'
            ? userMessage(`stream-user-turn-${seq}`, seq, `STREAM_USER_TURN_${index}`)
            : codexMessage(`stream-event-${seq}`, seq, `STREAM_EVENT_${index}`)
    })
    store.append(incoming)

    if (shouldBroadcast) {
        for (const row of incoming) {
            const event: SyncEvent = {
                type: 'message-received',
                namespace: NAMESPACE,
                sessionId: SESSION_ID,
                message: row,
            }
            sseManager.broadcast(event)
            emittedCount += 1
        }
    }

    return context.json({ ok: true, emittedCount })
})

app.route('/api', createMessagesRoutes(() => engine))
app.route('/api', createEventsRoutes(
    () => sseManager,
    () => engine,
    () => visibilityTracker,
))

const configuredPort = Number.parseInt(process.env.HAPI_E2E_API_PORT ?? '', 10)
const port = Number.isFinite(configuredPort) ? configuredPort : DEFAULT_PORT
const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 255,
    fetch: app.fetch,
})

console.log(`HAPI message-window E2E fixture listening on ${server.url}`)

function shutdown(): void {
    sseManager.stop()
    void server.stop(true)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
