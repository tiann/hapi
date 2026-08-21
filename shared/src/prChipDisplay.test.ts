import { describe, expect, it } from 'bun:test'
import { buildGithubPrExternalRef } from './externalRefs'
import { DEFAULT_PR_CHIP_DISPLAY, resolvePrChipDisplay } from './prChipDisplay'

describe('resolvePrChipDisplay', () => {
    it('treats undated forge snapshots as stale', () => {
        const ref = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1163,
            role: 'primary',
            source: 'user',
            linkedAt: 1
        })
        const withSnapshot = {
            ...ref,
            openState: 'open' as const,
            checks: 'passing' as const,
            merge: 'clean' as const
        }

        const resolved = resolvePrChipDisplay(withSnapshot, DEFAULT_PR_CHIP_DISPLAY, Date.now())
        expect(resolved.hasSnapshot).toBe(true)
        expect(resolved.stale).toBe(true)
    })

    it('keeps a fresh dated snapshot current', () => {
        const now = 1_700_000_000_000
        const ref = {
            ...buildGithubPrExternalRef({
                repo: 'tiann/hapi',
                number: 1163,
                role: 'primary',
                source: 'user',
                linkedAt: 1
            }),
            openState: 'open' as const,
            checks: 'passing' as const,
            merge: 'clean' as const,
            statusCheckedAt: now - 60_000
        }

        const resolved = resolvePrChipDisplay(ref, DEFAULT_PR_CHIP_DISPLAY, now)
        expect(resolved.hasSnapshot).toBe(true)
        expect(resolved.stale).toBe(false)
    })
})
