import { z } from 'zod';
import type { CodexAccountUsage, CodexUsageWindow } from '@hapi/protocol/apiTypes';
import type { CodexAppServerClient } from '../codexAppServerClient';

export const LUNA_RESERVE_MODEL = 'gpt-reserve';
const WindowSchema = z.object({
    usedPercent: z.unknown().optional(), windowDurationMins: z.unknown().optional(), resetsAt: z.unknown().optional()
});
const BucketSchema = z.object({
    limitId: z.string().nullish(), limitName: z.string().nullish(),
    primary: WindowSchema.nullish(), secondary: WindowSchema.nullish()
});
const UsageSchema = z.object({
    accountId: z.string().nullish(), ordinaryUsageAllowed: z.boolean().nullish(),
    rateLimits: BucketSchema, rateLimitsByLimitId: z.record(z.string(), BucketSchema).nullish(),
    rateLimitUpsell: z.unknown().optional()
});
const BannerSchema = z.object({
    banner_type: z.literal('luna_reserve'), blocked_model_slug: z.string().min(1).nullish()
});

function window(value: z.infer<typeof WindowSchema> | null | undefined): CodexUsageWindow | null {
    if (!value) return null;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    return {
        remainingPercent: finite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? 100 - value.usedPercent : null,
        windowDurationMins: finite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
        resetsAt: finite(value.resetsAt) && value.resetsAt >= 0 && value.resetsAt <= 8.64e12 ? value.resetsAt : null
    };
}
function bucket(value: z.infer<typeof BucketSchema> | null | undefined): CodexAccountUsage['ordinary'] {
    return { primary: window(value?.primary), secondary: window(value?.secondary) };
}

/** Reads authorize an explicit model selection only. No timers, settings writes, or turn replay. */
export class LunaReserve {
    private pending?: Promise<z.infer<typeof UsageSchema> | null>;
    constructor(private readonly client: Pick<CodexAppServerClient, 'request'>) {}

    private read(): Promise<z.infer<typeof UsageSchema> | null> {
        return this.pending ??= (async () => {
            try {
                // Older servers require null params. Probe before declaring Reserve capability.
                const probe = UsageSchema.parse(await this.client.request('account/rateLimits/read', null));
                if (!('ordinaryUsageAllowed' in probe)) return null;
                return UsageSchema.parse(await this.client.request('account/rateLimits/read', {
                    supportsLunaReserve: true, excludeResetCreditDetails: true
                }));
            } catch { return null; }
        })().finally(() => { this.pending = undefined; });
    }

    async usage(model: string | null | undefined): Promise<CodexAccountUsage | null> {
        const response = await this.read();
        if (!response?.accountId) return null;
        const banner = BannerSchema.safeParse(response.rateLimitUpsell);
        const reserve = Object.values(response.rateLimitsByLimitId ?? {}).find(value => value.limitName === LUNA_RESERVE_MODEL)
            ?? (response.rateLimits.limitName === LUNA_RESERVE_MODEL ? response.rateLimits : undefined);
        const ordinary = response.rateLimitsByLimitId?.codex
            ?? ((!response.rateLimits.limitId || response.rateLimits.limitId === 'codex') && response.rateLimits.limitName !== LUNA_RESERVE_MODEL ? response.rateLimits : undefined);
        return {
            ordinary: bucket(ordinary),
            reserve: model === LUNA_RESERVE_MODEL ? bucket(reserve) : null,
            reserveAvailable: response.ordinaryUsageAllowed === false && banner.success
                && (!banner.data.blocked_model_slug || banner.data.blocked_model_slug === model)
        };
    }
}
