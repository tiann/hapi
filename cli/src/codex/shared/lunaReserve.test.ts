import { describe, expect, it, vi } from 'vitest';
import { LunaReserve } from './lunaReserve';
import type { CodexAppServerClient } from '../codexAppServerClient';

describe('Reserve authorization and usage', () => {
    it('does not infer eligibility from buckets, percentages, timestamps, or unrelated banners', async () => {
        let response: unknown = { rateLimits: { limitId: 'codex' } };
        const request = vi.fn(async () => response);
        const reserve = new LunaReserve({ request } as unknown as CodexAppServerClient);
        expect(await reserve.usage('astra')).toBeNull();
        expect(request.mock.calls).toHaveLength(1);
        response = { accountId: 'a', ordinaryUsageAllowed: false,
            rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 0 } },
            rateLimitsByLimitId: { base_model_inference: { limitName: 'gpt-reserve', secondary: { usedPercent: 'bad' } } },
            rateLimitUpsell: { banner_type: 'luna_reserve', blocked_model_slug: 'other' }
        };
        expect((await reserve.usage('astra'))?.reserveAvailable).toBe(false);
        expect((await reserve.usage('gpt-reserve'))?.reserve?.secondary?.remainingPercent).toBeNull();
        response = { accountId: 'a', ordinaryUsageAllowed: null, rateLimits: {}, rateLimitUpsell: { banner_type: 'luna_reserve' } };
        expect((await reserve.usage('astra'))?.reserveAvailable).toBe(false);
        response = { ordinaryUsageAllowed: false, rateLimits: {}, rateLimitUpsell: { banner_type: 'luna_reserve' } };
        expect(await reserve.usage('astra')).toBeNull();
    });

    it('coalesces simultaneous reads and fails closed after a read error', async () => {
        const response = { accountId: 'a', ordinaryUsageAllowed: false, rateLimits: {}, rateLimitUpsell: { banner_type: 'luna_reserve' } };
        const request = vi.fn(async () => response);
        const reserve = new LunaReserve({ request } as unknown as CodexAppServerClient);
        const values = await Promise.all([reserve.usage('a'), reserve.usage('a')]);
        expect(values.every(value => value?.reserveAvailable)).toBe(true);
        expect(request).toHaveBeenCalledTimes(2);
        request.mockRejectedValueOnce(new Error('offline'));
        expect(await reserve.usage('a')).toBeNull();
    });
});
