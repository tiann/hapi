import type { CodexTokenUsage, CodexUsage, CodexUsageRateLimit } from '@hapi/protocol/types';

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
        ?? inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;

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
    const direct = record.reset_at ?? record.resetAt;
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
    const windowMinutes = firstNumber(record, ['window_minutes', 'windowMinutes', 'window', 'minutes']);
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
        return Object.values(directRecord);
    }

    if (record.primary || record.secondary) {
        return [record.primary, record.secondary];
    }

    return [];
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

    const contextWindow = contextLimit !== null && contextLimit > 0 && contextUsed !== null
        ? {
            usedTokens: contextUsed,
            limitTokens: contextLimit,
            percent: Math.min(100, Math.max(0, (contextUsed / contextLimit) * 100)),
            updatedAt: now
        }
        : undefined;

    if (!contextWindow && !totalTokenUsage && !lastTokenUsage && !rateLimits.fiveHour && !rateLimits.weekly) {
        return null;
    }

    return {
        ...(contextWindow ? { contextWindow } : {}),
        rateLimits,
        ...(totalTokenUsage ? { totalTokenUsage } : {}),
        ...(lastTokenUsage ? { lastTokenUsage } : {})
    };
}
