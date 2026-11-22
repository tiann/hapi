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

    it('prefers conflicts/blocked merge over passing or pending checks', () => {
        const now = 1_700_000_000_000
        const base = {
            ...buildGithubPrExternalRef({
                repo: 'tiann/hapi',
                number: 1163,
                role: 'primary' as const,
                source: 'user' as const,
                linkedAt: 1
            }),
            openState: 'open' as const,
            statusCheckedAt: now - 60_000
        }

        const conflictingPass = resolvePrChipDisplay({
            ...base,
            checks: 'pass',
            merge: 'conflicting'
        }, DEFAULT_PR_CHIP_DISPLAY, now)
        expect(conflictingPass.tone).toBe('needs_work')
        expect(conflictingPass.label).toBe('conflicts')

        const blockedPending = resolvePrChipDisplay({
            ...base,
            checks: 'pending',
            merge: 'blocked'
        }, DEFAULT_PR_CHIP_DISPLAY, now)
        expect(blockedPending.tone).toBe('needs_work')
        expect(blockedPending.label).toBe('merge blocked')

        const conflictingPending = resolvePrChipDisplay({
            ...base,
            checks: 'pending',
            merge: 'conflicting'
        }, DEFAULT_PR_CHIP_DISPLAY, now)
        expect(conflictingPending.tone).toBe('needs_work')
        expect(conflictingPending.label).toBe('conflicts')
    })

    it.each([
        ['merged', 'merged', 'merged'],
        ['closed', 'muted', 'closed'],
        ['draft', 'muted', 'draft']
    ] as const)(
        'prefers terminal openState=%s over clean+pass ready-to-merge',
        (openState, tone, label) => {
            const now = 1_700_000_000_000
            const resolved = resolvePrChipDisplay({
                ...buildGithubPrExternalRef({
                    repo: 'tiann/hapi',
                    number: 1163,
                    role: 'primary',
                    source: 'user',
                    linkedAt: 1
                }),
                openState,
                checks: 'pass',
                merge: 'clean',
                statusCheckedAt: now - 60_000
            }, DEFAULT_PR_CHIP_DISPLAY, now)
            expect(resolved.stale).toBe(false)
            expect(resolved.tone).toBe(tone)
            expect(resolved.label).toBe(label)
        }
    )
})
