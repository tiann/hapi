import { describe, expect, it } from 'vitest';
import type { RateLimitSnapshot } from '@/codex/appServerTypes';
import { selectCodexRateLimitSnapshotForTests } from './codexSubscriptionLimits';

function snapshot(limitId: string, limitName: string, usedPercent: number): RateLimitSnapshot {
    return {
        limitId,
        limitName,
        primary: {
            usedPercent,
            windowDurationMins: 300,
            resetsAt: 1
        },
        secondary: null,
        planType: 'pro'
    };
}

describe('Codex subscription limit snapshot selection', () => {
    it('uses the model-specific limitName before the generic codex bucket', () => {
        // Verifies Spark sessions read the Spark quota instead of the generic Codex quota.
        const generic = snapshot('codex', 'Codex', 80);
        const spark = snapshot('codex_bengalfox', 'GPT-5.3-Codex-Spark', 12);

        const selected = selectCodexRateLimitSnapshotForTests(
            generic,
            {
                codex: generic,
                codex_bengalfox: spark
            },
            'gpt-5.3-codex-spark'
        );

        expect(selected).toBe(spark);
    });

    it('falls back to the generic codex bucket when no model-specific bucket matches', () => {
        // Verifies regular Codex models keep using the existing generic quota bucket.
        const generic = snapshot('codex', 'Codex', 80);
        const spark = snapshot('codex_bengalfox', 'GPT-5.3-Codex-Spark', 12);

        const selected = selectCodexRateLimitSnapshotForTests(
            generic,
            {
                codex: generic,
                codex_bengalfox: spark
            },
            'gpt-5.5'
        );

        expect(selected).toBe(generic);
    });
});
