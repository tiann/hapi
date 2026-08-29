import type { CodexTokenUsage, CodexUsage, CodexUsageCredits, CodexUsageRateLimit } from '@hapi/protocol/types';

type NormalizerOptions = {
    now?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function firstNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
    if (!record) return null;
    for (const key of keys) {
        const value = asNumber(record[key]);
        if (value !== null) return value;
    }
    return null;
}

function normalizeTokenUsage(value: unknown): CodexTokenUsage | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    const inputTokens = firstNumber(record, ['input_tokens', 'inputTokens']) ?? 0;
    const cachedInputTokens = firstNumber(record, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']) ?? 0;
    const outputTokens = firstNumber(record, ['output_tokens', 'outputTokens']) ?? 0;
    const reasoningOutputTokens = firstNumber(record, ['reasoning_output_tokens', 'reasoningOutputTokens']) ?? 0;
    const totalTokens = firstNumber(record, ['total_tokens', 'totalTokens'])
        ?? inputTokens + outputTokens;

    if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && reasoningOutputTokens === 0 && totalTokens === 0) {
        return undefined;
    }

    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens
    };
}

function parseResetAt(record: Record<string, unknown>, now: number): number | undefined {
    const direct = record.resets_at ?? record.resetsAt ?? record.reset_at ?? record.resetAt;
    if (typeof direct === 'string') {
        const parsed = Date.parse(direct);
        if (Number.isFinite(parsed)) return parsed;
    }
    const directNumber = asNumber(direct);
    if (directNumber !== null) {
        return directNumber < 10_000_000_000 ? directNumber * 1000 : directNumber;
    }

    const resetsInSeconds = firstNumber(record, ['resets_in_seconds', 'resetsInSeconds', 'reset_in_seconds', 'resetInSeconds']);
    if (resetsInSeconds !== null) {
        return now + (resetsInSeconds * 1000);
    }

    const resetsInMinutes = firstNumber(record, ['resets_in_minutes', 'resetsInMinutes', 'reset_in_minutes', 'resetInMinutes']);
    if (resetsInMinutes !== null) {
        return now + (resetsInMinutes * 60_000);
    }

    return undefined;
}

function normalizeRateLimit(value: unknown, now: number): CodexUsageRateLimit | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    const usedPercent = firstNumber(record, ['used_percent', 'usedPercent', 'percent', 'usage_percent', 'usagePercent']);
    const windowMinutes = firstNumber(record, [
        'window_duration_mins',
        'windowDurationMins',
        'window_minutes',
        'windowMinutes',
        'window',
        'minutes'
    ]);
    if (usedPercent === null || windowMinutes === null) {
        return undefined;
    }

    const resetAt = parseResetAt(record, now);
    return {
        usedPercent,
        windowMinutes,
        ...(resetAt !== undefined ? { resetAt } : {})
    };
}

function collectRateLimitCandidates(value: unknown): unknown[] {
    const record = asRecord(value);
    if (!record) return [];

    const direct = record.rate_limits ?? record.rateLimits;
    const directRecord = asRecord(direct);
    if (Array.isArray(direct)) return direct;
    if (directRecord) {
        const named: unknown[] = [];
        if ('primary' in directRecord) named.push(directRecord.primary);
        if ('secondary' in directRecord) named.push(directRecord.secondary);
        if (named.length > 0) return named;
        return Object.values(directRecord);
    }

    if (record.primary || record.secondary) {
        return [record.primary, record.secondary];
    }

    return [];
}

function extractRateLimitsRoot(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (!record) return null;
    const direct = asRecord(record.rate_limits ?? record.rateLimits);
    return direct ?? record;
}

function extractRawRateLimits(value: unknown): unknown {
    const record = asRecord(value);
    if (!record) return undefined;
    if ('rate_limits' in record) return record.rate_limits;
    if ('rateLimits' in record) return record.rateLimits;
    const info = asRecord(record.info);
    if (info && 'rate_limits' in info) return info.rate_limits;
    if (info && 'rateLimits' in info) return info.rateLimits;
    const tokenUsage = asRecord(record.tokenUsage ?? record.token_usage);
    if (tokenUsage && 'rate_limits' in tokenUsage) return tokenUsage.rate_limits;
    if (tokenUsage && 'rateLimits' in tokenUsage) return tokenUsage.rateLimits;
    return undefined;
}

function normalizeCredits(value: unknown): CodexUsageCredits | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    const hasCreditsRaw = record.has_credits ?? record.hasCredits;
    const unlimitedRaw = record.unlimited;
    const balanceRaw = record.balance;

    const hasCredits = typeof hasCreditsRaw === 'boolean' ? hasCreditsRaw : undefined;
    const unlimited = typeof unlimitedRaw === 'boolean' ? unlimitedRaw : undefined;
    let balance: string | undefined;
    if (typeof balanceRaw === 'string' && balanceRaw.length > 0) {
        balance = balanceRaw;
    } else if (typeof balanceRaw === 'number' && Number.isFinite(balanceRaw)) {
        balance = String(balanceRaw);
    }

    if (hasCredits === undefined && unlimited === undefined && balance === undefined) {
        return undefined;
    }
    return {
        ...(hasCredits !== undefined ? { hasCredits } : {}),
        ...(unlimited !== undefined ? { unlimited } : {}),
        ...(balance !== undefined ? { balance } : {})
    };
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function unwrapUsagePayload(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (!record) return null;

    const info = asRecord(record.info);
    if (info) {
        return {
            ...record,
            ...info,
            rate_limits: info.rate_limits ?? info.rateLimits ?? record.rate_limits ?? record.rateLimits
        };
    }

    const tokenUsage = asRecord(record.tokenUsage ?? record.token_usage);
    if (tokenUsage) {
        return {
            ...record,
            ...tokenUsage,
            rate_limits: tokenUsage.rate_limits ?? tokenUsage.rateLimits ?? record.rate_limits ?? record.rateLimits
        };
    }

    return record;
}

export type CodexUsageUpdate = {
    usage: CodexUsage;
    hasRateLimitSnapshot: boolean;
    presentRateLimitBuckets: {
        fiveHour: boolean;
        weekly: boolean;
    };
    presentAccountFields: {
        credits: boolean;
        rateLimitReachedType: boolean;
        planType: boolean;
        limitId: boolean;
    };
};

function emptyAccountPresence(): CodexUsageUpdate['presentAccountFields'] {
    return {
        credits: false,
        rateLimitReachedType: false,
        planType: false,
        limitId: false
    };
}

function inspectRateLimitPresence(value: unknown): Pick<
    CodexUsageUpdate,
    'hasRateLimitSnapshot' | 'presentRateLimitBuckets' | 'presentAccountFields'
> {
    const raw = extractRawRateLimits(value);
    if (raw === undefined) {
        return {
            hasRateLimitSnapshot: false,
            presentRateLimitBuckets: { fiveHour: false, weekly: false },
            presentAccountFields: emptyAccountPresence()
        };
    }
    if (raw === null || typeof raw !== 'object') {
        return {
            hasRateLimitSnapshot: true,
            presentRateLimitBuckets: { fiveHour: true, weekly: true },
            presentAccountFields: {
                credits: true,
                rateLimitReachedType: true,
                planType: true,
                limitId: true
            }
        };
    }
    if (Array.isArray(raw)) {
        return {
            hasRateLimitSnapshot: true,
            presentRateLimitBuckets: { fiveHour: true, weekly: true },
            presentAccountFields: emptyAccountPresence()
        };
    }
    const root = raw as Record<string, unknown>;
    return {
        hasRateLimitSnapshot: true,
        presentRateLimitBuckets: {
            fiveHour: 'primary' in root || 'fiveHour' in root || 'five_hour' in root,
            weekly: 'secondary' in root || 'weekly' in root
        },
        presentAccountFields: {
            credits: 'credits' in root,
            rateLimitReachedType: 'rate_limit_reached_type' in root || 'rateLimitReachedType' in root,
            planType: 'plan_type' in root || 'planType' in root,
            limitId: 'limit_id' in root || 'limitId' in root
        }
    };
}

function payloadHasRateLimitSnapshot(value: unknown): boolean {
    return inspectRateLimitPresence(value).hasRateLimitSnapshot;
}

export function normalizeCodexUsageUpdate(value: unknown, options: NormalizerOptions = {}): CodexUsageUpdate | null {
    const presence = inspectRateLimitPresence(value);
    const usage = normalizeCodexUsage(value, options);
    if (usage) {
        return { usage, ...presence };
    }
    // Explicit empty/null rate-limit snapshots still need to clear stale buckets.
    if (presence.hasRateLimitSnapshot) {
        return {
            usage: { rateLimits: {} },
            ...presence
        };
    }
    return null;
}

export type ReplayUsageSample = {
    index: number;
    payload: unknown;
};

export type ReplayUsageAccumulator = {
    index: number;
    latestTokens: ReplayUsageSample | null;
    latestRateLimits: ReplayUsageSample | null;
};

export function createReplayUsageAccumulator(): ReplayUsageAccumulator {
    return {
        index: 0,
        latestTokens: null,
        latestRateLimits: null
    };
}

/** Track latest token-bearing and rate-limit-bearing replay samples separately. */
export function noteReplayUsageSample(accumulator: ReplayUsageAccumulator, payload: unknown): void {
    const update = normalizeCodexUsageUpdate(payload);
    if (!update) {
        return;
    }
    const sample: ReplayUsageSample = { index: accumulator.index++, payload };
    if (update.usage.contextWindow || update.usage.totalTokenUsage || update.usage.lastTokenUsage) {
        accumulator.latestTokens = sample;
    }
    if (update.hasRateLimitSnapshot) {
        accumulator.latestRateLimits = sample;
    }
}

/** Reverse-scan helper: keep the first (newest) sample per dimension. */
export function noteReplayUsageSampleIfAbsent(accumulator: ReplayUsageAccumulator, payload: unknown): void {
    const update = normalizeCodexUsageUpdate(payload);
    if (!update) {
        return;
    }
    const hasTokens = Boolean(
        update.usage.contextWindow || update.usage.totalTokenUsage || update.usage.lastTokenUsage
    );
    const hasRateLimits = update.hasRateLimitSnapshot;
    const takeTokens = hasTokens && !accumulator.latestTokens;
    const takeRateLimits = hasRateLimits && !accumulator.latestRateLimits;
    if (!takeTokens && !takeRateLimits) {
        return;
    }
    const sample: ReplayUsageSample = { index: accumulator.index++, payload };
    if (takeTokens) {
        accumulator.latestTokens = sample;
    }
    if (takeRateLimits) {
        accumulator.latestRateLimits = sample;
    }
}

/** At most two payloads, ordered by original replay index so merges apply correctly. */
export function orderedReplayUsagePayloads(accumulator: ReplayUsageAccumulator): unknown[] {
    return [...new Map(
        [accumulator.latestTokens, accumulator.latestRateLimits]
            .filter((item): item is ReplayUsageSample => item !== null)
            .map((item) => [item.index, item] as const)
    ).values()]
        .sort((a, b) => a.index - b.index)
        .map((item) => item.payload);
}

export type LiveUsageDimensions = {
    tokens: boolean;
    rateLimits: boolean;
};

export function emptyLiveUsageDimensions(): LiveUsageDimensions {
    return { tokens: false, rateLimits: false };
}

export function markLiveUsageDimensions(
    previous: LiveUsageDimensions | undefined,
    payload: unknown
): LiveUsageDimensions {
    const live = previous ?? emptyLiveUsageDimensions();
    const update = normalizeCodexUsageUpdate(payload);
    if (!update) {
        return live;
    }
    return {
        tokens: live.tokens
            || Boolean(update.usage.contextWindow || update.usage.totalTokenUsage || update.usage.lastTokenUsage),
        rateLimits: live.rateLimits || update.hasRateLimitSnapshot
    };
}

/** Keep transcript samples for dimensions not yet observed from live app-server. */
export function filterTranscriptUsageForLive(
    payload: unknown,
    live: LiveUsageDimensions
): unknown | null {
    const update = normalizeCodexUsageUpdate(payload);
    if (!update) {
        return null;
    }
    const hasTokens = Boolean(
        update.usage.contextWindow || update.usage.totalTokenUsage || update.usage.lastTokenUsage
    );
    const hasRateLimits = update.hasRateLimitSnapshot;
    const takeTokens = hasTokens && !live.tokens;
    const takeRateLimits = hasRateLimits && !live.rateLimits;
    if (!takeTokens && !takeRateLimits) {
        return null;
    }
    if (takeTokens && takeRateLimits) {
        return payload;
    }

    const record = asRecord(payload) ?? {};
    const info = asRecord(record.info) ?? {};
    if (takeTokens) {
        const nextInfo = { ...info };
        delete nextInfo.rate_limits;
        delete nextInfo.rateLimits;
        const next: Record<string, unknown> = {
            ...record,
            type: record.type ?? 'token_count',
            info: nextInfo
        };
        delete next.rate_limits;
        delete next.rateLimits;
        return next;
    }

    return {
        type: 'token_count',
        info: {
            rate_limits: info.rate_limits ?? info.rateLimits ?? record.rate_limits ?? record.rateLimits ?? null
        }
    };
}


export function normalizeCodexUsage(value: unknown, options: NormalizerOptions = {}): CodexUsage | null {
    const now = options.now ?? Date.now();
    const record = unwrapUsagePayload(value);
    if (!record) return null;

    const totalTokenUsage = normalizeTokenUsage(record.total_token_usage ?? record.totalTokenUsage ?? record.total_usage ?? record.totalUsage);
    const lastTokenUsage = normalizeTokenUsage(record.last_token_usage ?? record.lastTokenUsage ?? record.last_usage ?? record.lastUsage);
    const contextLimit = firstNumber(record, ['model_context_window', 'modelContextWindow', 'context_window', 'contextWindow']);
    const explicitContextUsed = firstNumber(record, ['context_window_used_tokens', 'contextWindowUsedTokens', 'used_tokens', 'usedTokens']);
    const cumulativeTotal = totalTokenUsage?.totalTokens
        ?? firstNumber(asRecord(record.total_token_usage ?? record.totalTokenUsage), ['total_tokens', 'totalTokens']);
    const cumulativeFitsContext = cumulativeTotal !== undefined
        && cumulativeTotal !== null
        && contextLimit !== null
        && cumulativeTotal <= contextLimit
        ? cumulativeTotal
        : null;
    const contextUsed = explicitContextUsed
        ?? lastTokenUsage?.totalTokens
        ?? firstNumber(asRecord(record.last_token_usage ?? record.lastTokenUsage), ['total_tokens', 'totalTokens'])
        ?? cumulativeFitsContext;

    const rateLimits: CodexUsage['rateLimits'] = {};
    for (const candidate of collectRateLimitCandidates(record)) {
        const bucket = normalizeRateLimit(candidate, now);
        if (!bucket) continue;
        if (bucket.windowMinutes === 300) {
            rateLimits.fiveHour = bucket;
        } else if (bucket.windowMinutes === 10080) {
            rateLimits.weekly = bucket;
        }
    }

    const rateLimitsRoot = extractRateLimitsRoot(record);
    const credits = normalizeCredits(rateLimitsRoot?.credits);
    const rateLimitReachedType = asNonEmptyString(
        rateLimitsRoot?.rate_limit_reached_type ?? rateLimitsRoot?.rateLimitReachedType
    );
    const planType = asNonEmptyString(rateLimitsRoot?.plan_type ?? rateLimitsRoot?.planType);
    const limitId = asNonEmptyString(rateLimitsRoot?.limit_id ?? rateLimitsRoot?.limitId);

    const contextWindow = contextLimit !== null && contextLimit > 0 && contextUsed !== null
        ? {
            usedTokens: contextUsed,
            limitTokens: contextLimit,
            percent: Math.min(100, Math.max(0, (contextUsed / contextLimit) * 100)),
            updatedAt: now
        }
        : undefined;

    if (
        !contextWindow
        && !totalTokenUsage
        && !lastTokenUsage
        && !rateLimits.fiveHour
        && !rateLimits.weekly
        && !credits
        && !rateLimitReachedType
    ) {
        return null;
    }

    return {
        ...(contextWindow ? { contextWindow } : {}),
        rateLimits,
        ...(credits ? { credits } : {}),
        ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
        ...(planType ? { planType } : {}),
        ...(limitId ? { limitId } : {}),
        ...(totalTokenUsage ? { totalTokenUsage } : {}),
        ...(lastTokenUsage ? { lastTokenUsage } : {})
    };
}
