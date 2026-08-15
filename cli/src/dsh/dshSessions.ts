import type {
    DshLocalSessionSummary,
    DshLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import { convertDshEvent, convertDshHistoryEntry } from './dshEvents'
import { DshWebClient, type DshHistoryEntry, type DshSessionSummary } from './dshWebClient'

const HISTORY_PAGE_MESSAGES = 100

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function projectionTitle(summary: DshSessionSummary): string {
    const title = summary.projections?.values.title
    return typeof title === 'string' && title.trim() ? title.trim() : 'DeepSeek Harness session'
}

function projectionMessageCount(summary: DshSessionSummary): number {
    const stats = asRecord(summary.projections?.values.sessionStats)
    const turns = stats?.turns
    return typeof turns === 'number' && Number.isInteger(turns) && turns >= 0 ? turns : 0
}

function toSummary(summary: DshSessionSummary): DshLocalSessionSummary {
    return {
        id: summary.sessionId,
        title: projectionTitle(summary),
        cwd: summary.cwd ?? null,
        modifiedAt: summary.updatedAt,
        messageCount: projectionMessageCount(summary),
        running: summary.running,
        parentSessionId: summary.parentSessionId ?? null
    }
}

export async function readDshHistoryAfter(
    client: DshWebClient,
    sessionId: string,
    afterSeq: number
): Promise<DshHistoryEntry[]> {
    const pages: DshHistoryEntry[][] = []
    let beforeSeq: number | undefined
    let lastMinimum = Number.POSITIVE_INFINITY

    while (true) {
        const page = await client.getHistory({
            sessionId,
            beforeSeq,
            maxMessages: HISTORY_PAGE_MESSAGES
        })
        if (page.entries.length === 0) break
        const minimum = Math.min(...page.entries.map((entry) => entry.event.seq))
        if (minimum >= lastMinimum) throw new Error(`DeepSeek Harness history cursor did not advance for ${sessionId}`)
        pages.unshift(page.entries)
        if (!page.hasMore || minimum <= afterSeq + 1) break
        lastMinimum = minimum
        beforeSeq = minimum
    }

    const bySeq = new Map<number, DshHistoryEntry>()
    for (const entry of pages.flat()) {
        if (entry.event.seq > afterSeq && !bySeq.has(entry.event.seq)) {
            bySeq.set(entry.event.seq, entry)
        }
    }
    return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
}

async function readAllHistory(client: DshWebClient, sessionId: string): Promise<DshHistoryEntry[]> {
    return readDshHistoryAfter(client, sessionId, -1)
}

async function loadTranscript(
    client: DshWebClient,
    summary: DshSessionSummary
): Promise<DshLocalSessionWithMessages> {
    const entries = await readAllHistory(client, summary.sessionId)
    const messages = entries.flatMap((entry) => convertDshHistoryEntry(summary.sessionId, entry))
    let model: string | null = null
    let reasoningEffort: string | null = null
    for (const entry of entries) {
        const converted = convertDshEvent(entry.event, entry)
        if (converted.model) model = converted.model
        if (converted.reasoningEffort) reasoningEffort = converted.reasoningEffort
    }
    const lastUserMessage = [...messages].reverse().find((message) => message.content.role === 'user')
    return {
        ...toSummary(summary),
        lastUserMessage: lastUserMessage?.content.role === 'user'
            ? lastUserMessage.content.content.text
            : null,
        model,
        reasoningEffort,
        messageCount: messages.length,
        messages,
        lastEventSeq: entries.at(-1)?.event.seq ?? null
    }
}

export async function listDshSessions(options?: {
    cwd?: string | null
    sessionIds?: Set<string> | null
    client?: DshWebClient
}): Promise<{ sessions: Array<DshLocalSessionSummary | DshLocalSessionWithMessages>; sourceUrl: string }> {
    const client = options?.client ?? new DshWebClient()
    await client.describe()
    const requestedIds = options?.sessionIds ?? null
    const cwd = options?.cwd?.trim() || null
    const summaries = (await client.listSessions()).filter((summary) => {
        if (requestedIds) return requestedIds.has(summary.sessionId)
        if (summary.blank || summary.origin === 'subagent') return false
        return !cwd || summary.cwd === cwd
    })

    if (!requestedIds) {
        return { sessions: summaries.map(toSummary), sourceUrl: client.baseUrl }
    }

    const sessions = await Promise.all(summaries.map((summary) => loadTranscript(client, summary)))
    return { sessions, sourceUrl: client.baseUrl }
}
