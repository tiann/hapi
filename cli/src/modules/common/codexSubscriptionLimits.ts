import type {
    CodexSubscriptionLimits,
    CodexSubscriptionLimitWindow,
    CodexSubscriptionLimitsResponse,
    GetCodexSubscriptionLimitsRequest as ProtocolGetCodexSubscriptionLimitsRequest
} from '@hapi/protocol/apiTypes';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { RateLimitSnapshot, RateLimitWindow } from '@/codex/appServerTypes';
import { getErrorMessage } from './rpcResponses';

export type GetCodexSubscriptionLimitsResponse = CodexSubscriptionLimitsResponse;
export type GetCodexSubscriptionLimitsRequest = ProtocolGetCodexSubscriptionLimitsRequest;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function normalizeLookup(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeWindow(value: RateLimitWindow | null | undefined): CodexSubscriptionLimitWindow | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }

    const usedPercent = asFiniteNumber(record.usedPercent);
    if (usedPercent === null) {
        return null;
    }

    return {
        usedPercent,
        windowDurationMins: asFiniteNumber(record.windowDurationMins),
        resetsAt: asFiniteNumber(record.resetsAt)
    };
}

function normalizeSnapshot(value: RateLimitSnapshot | null | undefined): CodexSubscriptionLimits | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }

    const primary = normalizeWindow(record.primary as RateLimitWindow | null | undefined);
    const secondary = normalizeWindow(record.secondary as RateLimitWindow | null | undefined);
    if (!primary && !secondary) {
        return null;
    }

    return {
        limitId: asStringOrNull(record.limitId),
        limitName: asStringOrNull(record.limitName),
        planType: asStringOrNull(record.planType),
        primary,
        secondary,
        updatedAt: Date.now()
    };
}

function pickCodexSnapshot(
    rateLimits: RateLimitSnapshot | undefined,
    rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null | undefined,
    model?: string | null
): RateLimitSnapshot | null {
    if (rateLimitsByLimitId) {
        const modelKey = normalizeLookup(model);
        if (modelKey) {
            const modelEntry = Object.entries(rateLimitsByLimitId).find(([key, entry]) => {
                const record = asRecord(entry);
                if (!record) {
                    return false;
                }

                return normalizeLookup(key) === modelKey
                    || normalizeLookup(asStringOrNull(record.limitId)) === modelKey
                    || normalizeLookup(asStringOrNull(record.limitName)) === modelKey;
            })?.[1];
            if (modelEntry) {
                return modelEntry;
            }
        }

        const direct = rateLimitsByLimitId.codex;
        if (direct) {
            return direct;
        }

        const codexEntry = Object.values(rateLimitsByLimitId).find((entry) => {
            const record = asRecord(entry);
            if (!record) {
                return false;
            }
            const limitId = asStringOrNull(record.limitId)?.toLowerCase();
            const limitName = asStringOrNull(record.limitName)?.toLowerCase();
            return limitId === 'codex' || limitName?.includes('codex') === true;
        });
        if (codexEntry) {
            return codexEntry;
        }
    }

    return rateLimits ?? null;
}

export const selectCodexRateLimitSnapshotForTests = pickCodexSnapshot;

export async function getCodexSubscriptionLimits(model?: string | null): Promise<CodexSubscriptionLimits> {
    const client = new CodexAppServerClient();

    try {
        await client.connect();
        await client.initialize({
            clientInfo: {
                name: 'hapi-codex-limits',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        const response = await client.readAccountRateLimits();
        const snapshot = pickCodexSnapshot(response.rateLimits, response.rateLimitsByLimitId, model);
        const limits = normalizeSnapshot(snapshot);
        if (!limits) {
            throw new Error('Codex subscription limits unavailable');
        }
        return limits;
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to read Codex subscription limits'));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
