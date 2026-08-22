import type { UsageAgentStatus, UsageCost, UsageSummaryBucket, UsageSummaryResponse } from '@hapi/protocol/apiTypes'
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

/** Cost amounts keep their fractional precision (unlike token counts). */
function asAmount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null
}

function firstCount(record: RecordValue, ...keys: string[]): number {
    for (const key of keys) {
        const value = asCount(record[key])
        if (value !== null) return value
    }
    return 0
}

/**
 * ACP `usage_update.cost` is a cumulative session cost. HAPI's generic wire
 * carries it flat (`cost` + `costCurrency`), but the ACP object shape
 * (`{ amount, currency }`) is also accepted for robustness.
 */
function parseUsageCost(data: RecordValue): { amount: number; currency: string } | null {
    const costRecord = asRecord(data.cost)
    const amount = costRecord !== null ? asAmount(costRecord.amount) : asAmount(data.cost)
    if (amount === null) return null
    const currencyValue = costRecord !== null ? costRecord.currency : data.costCurrency
    const currency = typeof currencyValue === 'string' && currencyValue.trim()
        ? currencyValue.trim()
        : 'USD'
    return { amount, currency }
}

const AGENT_STATUS_RANK: Record<UsageAgentStatus, number> = {
    'complete': 3,
    'cost-only': 2,
    'context-only': 1,
    'not-reported': 0
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
            lastCacheCreationTokens: null,
            contextOnly: false,
            cost: null,
            costCurrency: null
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
        const hasProcessedTokens = rawInputTokens + outputTokens + cacheReadTokens + cacheCreationTokens > 0
        const cost = parseUsageCost(data)
        // Zero-token messages still carry presence information: an ACP agent
        // may report only context (`usage_update.used/size`) or only a
        // cumulative session cost. Both are indexed so the UI can distinguish
        // "context-only"/"cost-only" from an agent that reports nothing. An
        // explicit zero context is still a report (asCount returns null only
        // for missing values), and a context window alone is a presence too.
        const contextTokens = asCount(info.contextTokens ?? info.context_tokens)
        const contextWindow = asCount(info.modelContextWindow ?? info.model_context_window)
        const contextOnly = !hasProcessedTokens
            && (contextTokens !== null || contextWindow !== null)
        if (!hasProcessedTokens && !contextOnly && cost === null) return null
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
            lastCacheCreationTokens,
            contextOnly,
            cost: cost?.amount ?? null,
            costCurrency: cost?.currency ?? null
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

    // All-time agent availability is independent of the selected range: a
    // session that ever reported tokens/context/cost keeps that status even
    // when the current range has no events.
    const sessionStatus = new Map<string, UsageAgentStatus>()
    for (const event of events) {
        const status: UsageAgentStatus | null = event.inputTokens + event.outputTokens
                + event.cacheReadTokens + event.cacheCreationTokens > 0
            ? 'complete'
            : event.cost !== null
                ? 'cost-only'
                : event.contextOnly
                    ? 'context-only'
                    : null
        if (!status) continue
        const previous = sessionStatus.get(event.sessionId)
        if (!previous || AGENT_STATUS_RANK[status] > AGENT_STATUS_RANK[previous]) {
            sessionStatus.set(event.sessionId, status)
        }
    }

    // Cumulative session cost is a point-in-time value, not a delta: every
    // reported point is kept in chronological order so resets can be detected.
    // For bounded ranges the amount shown is the cumulative growth inside the
    // range (points walked against the latest point before the range).
    type CostPoint = { amount: number; currency: string; createdAt: number; sourceSeq: number }
    const sessionCostPoints = new Map<string, CostPoint[]>()
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
        if (event.cost !== null) {
            const points = sessionCostPoints.get(event.sessionId) ?? []
            points.push({
                amount: event.cost,
                currency: event.costCurrency ?? 'USD',
                createdAt: event.createdAt,
                sourceSeq: event.sourceSeq
            })
            sessionCostPoints.set(event.sessionId, points)
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

    // Costs are never summed across currencies into one labeled scalar: each
    // currency keeps its own total (e.g. USD 1 + EUR 1 stays two entries).
    // For a bounded range the session cost is the cumulative growth inside
    // the range, walking every in-range point against the previous one: a
    // counter reset (a lower value) contributes its full amount, so spend
    // accumulated before the reset is not discarded. A currency change in the
    // chain cannot be diffed, so that session's cost is omitted.
    const rangedCost = new Map<string, { amount: number; currency: string }>()
    const sessionById = new Map(sessions.map((session) => [session.id, session]))
    for (const [sessionId, points] of sessionCostPoints) {
        const session = sessionById.get(sessionId)
        const baseline = from !== null
            ? [...points].reverse().find((point) => point.createdAt < from) ?? null
            : null
        const inRange = from !== null
            ? points.filter((point) => point.createdAt >= from && point.createdAt <= now)
            : points
        if (inRange.length === 0) continue
        // A missing baseline is only a true zero when the session itself
        // started inside the range; an older session's first in-range sample
        // cannot be attributed, but later in-range growth is still measurable.
        let previous = baseline
        let pointsToCount = inRange
        if (from !== null && previous === null && session && session.createdAt < from) {
            previous = inRange[0] ?? null
            pointsToCount = inRange.slice(1)
        }
        let total = 0
        let currency: string | null = null
        let mismatch = false
        for (const point of pointsToCount) {
            if (previous !== null && previous.currency !== point.currency) {
                mismatch = true
                break
            }
            if (previous === null) {
                total += point.amount
            } else {
                total += point.amount >= previous.amount
                    ? point.amount - previous.amount
                    : point.amount
            }
            previous = point
            currency = point.currency
        }
        if (mismatch) continue
        if (total > 0 && currency !== null) {
            rangedCost.set(sessionId, { amount: total, currency })
        }
    }
    const totalCosts = new Map<string, number>()
    for (const cost of rangedCost.values()) {
        totalCosts.set(cost.currency, (totalCosts.get(cost.currency) ?? 0) + cost.amount)
    }

    // Per-agent availability: every session's agent starts as "not-reported";
    // the strongest status observed across its events upgrades it.
    const agentEntries = new Map<string, { status: UsageAgentStatus; sessions: number; costs: Map<string, number> }>()
    for (const session of sessions) {
        const agent = sessionAgent(session)
        if (agent === 'unknown') continue
        const entry = agentEntries.get(agent)
            ?? { status: 'not-reported' as UsageAgentStatus, sessions: 0, costs: new Map<string, number>() }
        entry.sessions += 1
        const status = sessionStatus.get(session.id)
        if (status && AGENT_STATUS_RANK[status] > AGENT_STATUS_RANK[entry.status]) {
            entry.status = status
        }
        agentEntries.set(agent, entry)
    }
    for (const [sessionId, cost] of rangedCost) {
        const session = sessionById.get(sessionId)
        if (!session) continue
        const agent = sessionAgent(session)
        if (agent === 'unknown') continue
        const entry = agentEntries.get(agent)
        if (!entry) continue
        entry.costs.set(cost.currency, (entry.costs.get(cost.currency) ?? 0) + cost.amount)
    }

    const toCosts = (values: Map<string, number>): UsageCost[] => Array.from(values.entries())
        .map(([currency, amount]) => ({ amount, currency }))
        .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency))

    const sortBuckets = (values: Map<string, Totals>): UsageSummaryBucket[] => Array.from(values.entries())
        .map(([key, value]) => toBucket(key, value))
        .sort((a, b) => b.totalTokens - a.totalTokens)

    return {
        range: { from, to: now },
        totals: { ...totals, sessions: sessionsWithUsage.size, costs: toCosts(totalCosts) },
        daily: Array.from(daily.entries())
            .map(([key, value]) => toBucket(key, value))
            .sort((a, b) => a.key.localeCompare(b.key)),
        byAgent: sortBuckets(byAgent),
        byModel: sortBuckets(byModel),
        agents: Array.from(agentEntries.entries())
            .map(([agent, entry]) => ({
                agent,
                status: entry.status,
                sessions: entry.sessions,
                costs: toCosts(entry.costs)
            }))
            .sort((a, b) => a.agent.localeCompare(b.agent)),
        updatedAt: now
    }
}
