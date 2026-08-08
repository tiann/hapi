import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_PR_CHIP_DISPLAY,
    formatGithubPrChipLabel,
    mergePrChipDisplayProfile,
    resolveGithubPrChipDisplay
} from '@hapi/protocol'
import { formatGithubPrChipTitle } from './SessionPrChip'
import type { GithubPrExternalRef } from '@/types/api'

const baseRef = (over: Partial<GithubPrExternalRef> = {}): GithubPrExternalRef => ({
    kind: 'github_pr',
    repo: 'tiann/hapi',
    number: 1163,
    url: 'https://github.com/tiann/hapi/pull/1163',
    role: 'primary',
    ...over
})

const keyedT = (key: string, params?: Record<string, string | number>) =>
    params && 'n' in params ? `${key}:${params.n}` : key

afterEach(() => {
    vi.useRealTimers()
})

describe('SessionPrChip helpers', () => {
    it('formats the chip label from the PR number only when snapshot is absent', () => {
        const ref = baseRef()
        const display = resolveGithubPrChipDisplay(ref, DEFAULT_PR_CHIP_DISPLAY)
        expect(formatGithubPrChipLabel(ref, display)).toBe('PR')
    })

    it('uses generic forge label without Meta action prose by default', () => {
        const ref = baseRef({
            checks: 'pass',
            merge: 'clean',
            statusCheckedAt: 1_700_000_000_000
        })
        const display = resolveGithubPrChipDisplay(ref, DEFAULT_PR_CHIP_DISPLAY, 1_700_000_000_000)
        expect(display.label).toBe('ready to merge')
        expect(display.action).toBeUndefined()
        // Forge defaults have no emoji — compact glyph is the PR marker.
        expect(formatGithubPrChipLabel(ref, display)).toBe('PR')
    })

    it('mutes to ? when statusCheckedAt is older than staleMs', () => {
        const checkedAt = 1_700_000_000_000
        const ref = baseRef({
            checks: 'fail',
            statusCheckedAt: checkedAt
        })
        const display = resolveGithubPrChipDisplay(
            ref,
            DEFAULT_PR_CHIP_DISPLAY,
            checkedAt + DEFAULT_PR_CHIP_DISPLAY.staleMs + 1
        )
        expect(display.stale).toBe(true)
        expect(formatGithubPrChipLabel(ref, display)).toBe('?')
    })

    it('applies estate display overrides for emoji and action terms', () => {
        const profile = mergePrChipDisplayProfile({
            estateCodes: {
                'babysit.needs_work': {
                    emoji: '⚠️',
                    tone: 'needs_work',
                    label: 'needs work',
                    action: 'rebase (merge state dirty)'
                }
            }
        })
        vi.useFakeTimers()
        const checkedAt = 1_700_000_000_000
        vi.setSystemTime(checkedAt + 90 * 60_000)
        const ref = baseRef({
            merge: 'conflicting',
            statusCheckedAt: checkedAt,
            estateCode: 'babysit.needs_work'
        })
        const display = resolveGithubPrChipDisplay(ref, profile, Date.now())
        const title = formatGithubPrChipTitle(ref, display, keyedT)
        expect(formatGithubPrChipLabel(ref, display)).toBe('⚠️')
        expect(title).toBe(
            '⚠️ tiann/hapi#1163 · needs work · checked session.time.hoursAgo:1 — rebase (merge state dirty)'
        )
        expect(title).not.toMatch(/T\d{2}:\d{2}:\d{2}/)
    })
})
