import type { UsageSummaryBucket, UsageSummaryResponse } from '@hapi/protocol/apiTypes'
import type { StoredMessage, StoredSession } from '../store'
import type { UsageEvent } from '../store/usage'
import type { Store } from '../store'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function asCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : null
}

function firstCount(record: RecordValue, ...keys: string[]): number {
    for (const key of keys) {
        const value = asCount(record[key])
        if (value !== null) return value
    }
    return 0
}

function normalizeInputTokens(
    data: RecordValue,
    inputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    legacySemantics: 'includes-cache' | 'excludes-cache'
): number {
    // v1 generic usage messages make their input contract self-describing.
    // Unknown/missing metadata intentionally falls back to the historical
    // provider shape so already persisted transcripts remain readable.
    const declaredSemantics = data.usageSchema === 'hapi.usage.v1'
        && (data.inputTokenSemantics === 'includes-cache' || data.inputTokenSemantics === 'excludes-cache')
        ? data.inputTokenSemantics
        : null
    const semantics = declaredSemantics ?? legacySemantics
    return semantics === 'excludes-cache'
        ? inputTokens + cacheReadTokens + cacheCreationTokens
        : inputTokens
}

function sessionAgent(session: StoredSession): string {
    const metadata = asRecord(session.metadata)
    const flavor = metadata?.flavor
    return typeof flavor === 'string' && flavor.trim() ? flavor.trim() : 'unknown'
}

function sessionModel(session: StoredSession): string | null {
    return typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null
}

function parseUsageEvent(session: StoredSession, message: StoredMessage): UsageEvent | null {
    const envelope = asRecord(message.content)
    if (envelope?.role !== 'agent') return null

    const payload = asRecord(envelope.content)
    if (!payload) return null
    const data = asRecord(payload.data)
    if (!data) return null

    // Claude stream-json/SDK messages. A stream emits several updates for one
    // assistant message, so the provider's message id is the stable upsert key.
    if (payload.type === 'output' && data.type === 'assistant') {
        const assistant = asRecord(data.message)
        const usage = asRecord(assistant?.usage)
        if (!usage) return null
        const inputTokens = firstCount(usage, 'input_tokens', 'inputTokens')
        const outputTokens = firstCount(usage, 'output_tokens', 'outputTokens')
        const cacheReadTokens = firstCount(usage, 'cache_read_input_tokens', 'cacheReadTokens', 'cachedInputTokens')
        const cacheCreationTokens = firstCount(usage, 'cache_creation_input_tokens', 'cacheCreationTokens', 'cacheWriteInputTokens')
        if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens <= 0) return null
        const providerId = typeof assistant?.id === 'string' ? assistant.id : message.id
        const model = typeof assistant?.model === 'string' && assistant.model.trim()
            ? assistant.model.trim()
            : null
        return {
            sessionId: session.id,
            sourceKey: `claude|${providerId}`,
            sourceSeq: message.seq,
            createdAt: message.createdAt,
            agent: 'claude',
            model,
            kind: 'delta',
            inputTokens: normalizeInputTokens(data, inputTokens, cacheReadTokens, cacheCreationTokens, 'excludes-cache'),
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            lastInputTokens: null,
            lastOutputTokens: null,
            lastCacheReadTokens: null,
            lastCacheCreationTokens: null
        }
    }

    // Codex forwards cumulative thread totals plus the most recent request.
    // ACP-compatible backends wrap per-request usage in `total`, so only Codex
    // should be diffed as a cumulative stream.
    if (data.type === 'token_count' || data.type === 'usage') {
        if (data.hapiUsageScope === 'imported-history') return null
        const info = asRecord(data.info) ?? data
        const agent = sessionAgent(session)
        const explicitThreadId = typeof data.threadId === 'string'
            ? data.threadId
            : typeof data.thread_id === 'string'
                ? data.thread_id
                : null
        const metadata = asRecord(session.metadata)
        const hasImportedCodexHistory = typeof metadata?.codexSourceSessionId === 'string'
            || metadata?.lifecycleState === 'imported'
        if (agent === 'codex' && explicitThreadId === null && hasImportedCodexHistory) {
            return null
        }
        const cumulativeTotal = agent === 'codex'
            ? asRecord(info.total)
                ?? asRecord(info.total_token_usage)
                ?? asRecord(info.totalTokenUsage)
            : null
        const last = asRecord(info.last)
            ?? asRecord(info.last_token_usage)
            ?? asRecord(info.lastTokenUsage)
            ?? (data.type === 'usage' ? info : null)
        const total = cumulativeTotal ?? (agent === 'codex' ? last : asRecord(info.total) ?? info)
        if (!total) return null
        const rawInputTokens = firstCount(total, 'inputTokens', 'input_tokens')
        const outputTokens = firstCount(total, 'outputTokens', 'output_tokens')
        const cacheReadTokens = firstCount(total, 'cachedInputTokens', 'cached_input_tokens', 'cacheReadTokens', 'cache_read_input_tokens')
        const cacheCreationTokens = firstCount(total, 'cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheCreationTokens', 'cache_creation_input_tokens')
        if (rawInputTokens + outputTokens + cacheReadTokens + cacheCreationTokens <= 0) return null
        const threadId = explicitThreadId ?? session.id
        const scope = typeof data.scopeRole === 'string'
            ? data.scopeRole
            : typeof data.scope_role === 'string'
                ? data.scope_role
                : 'parent'
        const isCumulative = cumulativeTotal !== null
        const turnId = typeof data.turnId === 'string'
            ? data.turnId
            : typeof data.turn_id === 'string'
                ? data.turn_id
                : ''
        const model = typeof data.model === 'string' && data.model.trim()
            ? data.model.trim()
            : null
        // Codex/Kimi provider formats have always reported inclusive input.
        // Imported Pi usage is known-inclusive, and for generic ACP an own
        // `model` property is the only strong provenance for the unmarked
        // inclusive wire introduced with the usage dashboard. Older ambiguous
        // payloads are conservatively treated as cache-exclusive.
        const legacyInputSemantics = agent === 'codex'
            || agent === 'kimi'
            || (agent === 'pi' && message.localId?.startsWith('pi:'))
            || Object.prototype.hasOwnProperty.call(data, 'model')
            ? 'includes-cache'
            : 'excludes-cache'
        const inputTokens = normalizeInputTokens(
            data,
            rawInputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            legacyInputSemantics
        )
        const lastOutputTokens = last ? firstCount(last, 'outputTokens', 'output_tokens') : null
        const lastCacheReadTokens = last
            ? firstCount(last, 'cachedInputTokens', 'cached_input_tokens', 'cacheReadTokens', 'cache_read_input_tokens')
            : null
        const lastCacheCreationTokens = last
            ? firstCount(last, 'cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheCreationTokens', 'cache_creation_input_tokens')
            : null
        const lastInputTokens = last
            ? normalizeInputTokens(
                data,
                firstCount(last, 'inputTokens', 'input_tokens'),
                lastCacheReadTokens ?? 0,
                lastCacheCreationTokens ?? 0,
                legacyInputSemantics
            )
            : null
        return {
            sessionId: session.id,
            sourceKey: isCumulative
                ? [
                    'cumulative',
                    threadId,
                    scope,
                    turnId,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheCreationTokens
                ].join('|')
                : `delta|${message.id}`,
            sourceSeq: message.seq,
            createdAt: message.createdAt,
            agent,
            model,
            kind: isCumulative ? 'cumulative' : 'delta',
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            lastInputTokens,
            lastOutputTokens,
            lastCacheReadTokens,
            lastCacheCreationTokens
        }
    }

    return null
}

function collectUsageEvents(store: Store, sessions: StoredSession[]): void {
    const scanStates = store.usage.getScanStates(sessions.map((session) => session.id))
    for (const session of sessions) {
        const messageEpoch = store.messages.getMessageEpoch(session.id)
        const scanState = scanStates.get(session.id)
        const replaceEvents = !scanState || scanState.messageEpoch !== messageEpoch
        const afterSeq = replaceEvents ? 0 : scanState.lastSeq
        const messages = store.messages.getMessagesAfterSeq(session.id, afterSeq)
        const events = new Map<string, UsageEvent>()
        let indexedModels: Map<string, string> | null = null
        const getIndexedModel = (sourceKey: string): string | null => {
            if (indexedModels === null) {
                indexedModels = new Map(
                    store.usage.getEvents([session.id])
                        .filter((event): event is UsageEvent & { model: string } => event.model !== null)
                        .map((event) => [event.sourceKey, event.model])
                )
            }
            return indexedModels.get(sourceKey) ?? null
        }
        const fallbackModel = sessionModel(session)
        for (const message of messages) {
            const event = parseUsageEvent(session, message)
            if (!event) continue
            const existingEvent = events.get(event.sourceKey)
            const explicitModel = event.model
            event.model = explicitModel
                ?? existingEvent?.model
                ?? getIndexedModel(event.sourceKey)
                ?? fallbackModel
            if (event.kind === 'delta' || !existingEvent) {
                events.set(event.sourceKey, event)
            } else if (explicitModel !== null) {
                // A replay may add model metadata missing from the original snapshot.
                existingEvent.model = explicitModel
            }
        }
        const lastSeq = messages.at(-1)?.seq ?? afterSeq
        if (messages.length > 0 || replaceEvents) {
            store.usage.recordScan(
                session.id,
                messageEpoch,
                lastSeq,
                Array.from(events.values()),
                replaceEvents
            )
        }
    }
}

type Totals = Omit<UsageSummaryBucket, 'key'>

function emptyTotals(): Totals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        uncachedTokens: 0,
        requests: 0
    }
}

function addTotals(target: Totals, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): void {
    target.inputTokens += inputTokens
    target.outputTokens += outputTokens
    target.cacheReadTokens += cacheReadTokens
    target.cacheCreationTokens += cacheCreationTokens
    // Codex/Kimi inputTokens already includes cached input. Claude's raw
    // input_tokens excludes cache fields and is normalized before this call.
    target.totalTokens += inputTokens + outputTokens
    target.uncachedTokens += Math.max(0, inputTokens - cacheReadTokens) + outputTokens
    target.requests += 1
}

type UsageSnapshot = [number, number, number, number]

function cumulativeSnapshotDelta(
    current: UsageSnapshot,
    previous: UsageSnapshot | null,
    last: UsageSnapshot | null
): UsageSnapshot {
    // A provider reset applies to the entire snapshot. Mixing a `last` value
    // for one regressed counter with deltas from the old baseline for the other
    // counters invents a request that never existed.
    const reset = previous === null || current.some((value, index) => value < previous[index])
    if (reset) return last ?? current
    return current.map((value, index) => value - previous[index]) as UsageSnapshot
}

function toBucket(key: string, totals: Totals): UsageSummaryBucket {
    return { key, ...totals }
}

function createDayFormatter(timeZone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        calendar: 'iso8601',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    })
}

function dayKey(timestamp: number, formatter: Intl.DateTimeFormat): string {
    const parts = formatter.formatToParts(new Date(timestamp))
    const year = parts.find((part) => part.type === 'year')?.value
    const month = parts.find((part) => part.type === 'month')?.value
    const day = parts.find((part) => part.type === 'day')?.value
    if (!year || !month || !day) throw new Error('Failed to format usage day')
    return `${year}-${month}-${day}`
}

export function getUsageSummary(
    store: Store,
    namespace: string,
    range: string | undefined,
    timeZone: string = 'UTC'
): UsageSummaryResponse {
    const sessions = store.sessions.getSessionsByNamespace(namespace)
    // This is intentionally lazy. Existing HAPI databases have no usage table;
    // the first dashboard request backfills history, while later requests only
    // update the idempotent event rows.
    collectUsageEvents(store, sessions)

    const now = Date.now()
    const days = range === '30d' ? 30 : range === 'all' ? null : 7
    const from = days === null ? null : now - days * 24 * 60 * 60 * 1000
    const sessionIds = new Set(sessions.map((session) => session.id))
    const events = store.usage.getEvents(Array.from(sessionIds))
    const isInRange = (event: UsageEvent) => (from === null || event.createdAt >= from) && event.createdAt <= now

    const totals = emptyTotals()
    const daily = new Map<string, Totals>()
    const byAgent = new Map<string, Totals>()
    const byModel = new Map<string, Totals>()
    const sessionsWithUsage = new Set<string>()
    const cumulativePrevious = new Map<string, UsageSnapshot>()
    const cumulativeFingerprints = new Set<string>()
    const dayFormatter = createDayFormatter(timeZone)

    for (const event of events) {
        let inputTokens = event.inputTokens
        let outputTokens = event.outputTokens
        let cacheReadTokens = event.cacheReadTokens
        let cacheCreationTokens = event.cacheCreationTokens
        let duplicateCumulativeEvent = false
        if (event.kind === 'cumulative') {
            const sourceParts = event.sourceKey.split('|')
            const streamKey = sourceParts.slice(0, 3).join('|')
            const previous = cumulativePrevious.get(streamKey) ?? null
            const current: UsageSnapshot = [
                event.inputTokens,
                event.outputTokens,
                event.cacheReadTokens,
                event.cacheCreationTokens
            ]
            const last: UsageSnapshot | null = event.lastInputTokens !== null
                && event.lastOutputTokens !== null
                && event.lastCacheReadTokens !== null
                && event.lastCacheCreationTokens !== null
                ? [
                    event.lastInputTokens,
                    event.lastOutputTokens,
                    event.lastCacheReadTokens,
                    event.lastCacheCreationTokens
                ]
                : null
            const delta = cumulativeSnapshotDelta(current, previous, last)
            inputTokens = delta[0]
            outputTokens = delta[1]
            cacheReadTokens = delta[2]
            cacheCreationTokens = delta[3]
            cumulativePrevious.set(streamKey, current)
            const turnId = sourceParts[3]
            if (turnId) {
                const fingerprint = [
                    event.sessionId,
                    turnId,
                    event.inputTokens,
                    event.outputTokens,
                    event.cacheReadTokens,
                    event.cacheCreationTokens,
                    event.lastInputTokens,
                    event.lastOutputTokens,
                    event.lastCacheReadTokens,
                    event.lastCacheCreationTokens
                ].join('|')
                duplicateCumulativeEvent = cumulativeFingerprints.has(fingerprint)
                cumulativeFingerprints.add(fingerprint)
            }
        }
        if (duplicateCumulativeEvent || !isInRange(event) || inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens <= 0) continue
        // Cache reads and writes partition processed input. Preserve the
        // request and its primary token counts when a provider emits an
        // impossible partition, but conservatively decline to credit either
        // cache bucket because their split is not trustworthy.
        if (cacheReadTokens + cacheCreationTokens > inputTokens) {
            cacheReadTokens = 0
            cacheCreationTokens = 0
        }
        addTotals(totals, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
        const eventDayKey = dayKey(event.createdAt, dayFormatter)
        const dailyTotals = daily.get(eventDayKey) ?? emptyTotals()
        addTotals(dailyTotals, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
        daily.set(eventDayKey, dailyTotals)
        const agentTotals = byAgent.get(event.agent) ?? emptyTotals()
        addTotals(agentTotals, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
        byAgent.set(event.agent, agentTotals)
        const modelKey = event.model ?? 'unknown'
        const modelTotals = byModel.get(modelKey) ?? emptyTotals()
        addTotals(modelTotals, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
        byModel.set(modelKey, modelTotals)
        sessionsWithUsage.add(event.sessionId)
    }

    const sortBuckets = (values: Map<string, Totals>): UsageSummaryBucket[] => Array.from(values.entries())
        .map(([key, value]) => toBucket(key, value))
        .sort((a, b) => b.totalTokens - a.totalTokens)

    return {
        range: { from, to: now },
        totals: { ...totals, sessions: sessionsWithUsage.size },
        daily: Array.from(daily.entries())
            .map(([key, value]) => toBucket(key, value))
            .sort((a, b) => a.key.localeCompare(b.key)),
        byAgent: sortBuckets(byAgent),
        byModel: sortBuckets(byModel),
        updatedAt: now
    }
}
