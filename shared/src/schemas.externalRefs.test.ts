import { describe, expect, it } from 'vitest'
import { ExternalRefSchema, ExternalRefsSchema, MetadataSchema } from './schemas'
import {
    buildGithubPrExternalRef,
    formatGithubPrChipLabel,
    getPrimaryGithubPrRef,
    parseGithubPrInput,
    resolveGithubPrChipDisplay,
    upsertGithubPrIntoExternalRefs
} from './externalRefs'
import { DEFAULT_PR_CHIP_DISPLAY, mergePrChipDisplayProfile } from './prChipDisplay'

describe('ExternalRefSchema', () => {
    const validPr = {
        kind: 'github_pr' as const,
        repo: 'tiann/hapi',
        number: 1160,
        url: 'https://github.com/tiann/hapi/pull/1160',
        role: 'primary' as const
    }

    it('accepts a github_pr ref', () => {
        const parsed = ExternalRefSchema.safeParse(validPr)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data).toEqual(validPr)
        }
    })

    it('accepts optional source and linkedAt provenance fields', () => {
        const parsed = ExternalRefSchema.safeParse({
            ...validPr,
            source: 'agent',
            linkedAt: 1_700_000_000_000
        })
        expect(parsed.success).toBe(true)
    })

    it('accepts forge snapshot + opaque estateCode (not Meta status enums)', () => {
        const parsed = ExternalRefSchema.safeParse({
            ...validPr,
            openState: 'open',
            checks: 'pass',
            merge: 'clean',
            statusCheckedAt: 1_700_000_000_000,
            estateCode: 'babysit.green'
        })
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.merge).toBe('clean')
            expect(parsed.data.estateCode).toBe('babysit.green')
        }
    })

    it('strips legacy Meta status enum keys (unknown keys; not protocol fields)', () => {
        const parsed = ExternalRefSchema.safeParse({
            ...validPr,
            status: 'needs_work',
            statusAction: 'wait on tiann'
        })
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data).toEqual(validPr)
            expect('status' in parsed.data).toBe(false)
        }
    })

    it('rejects unknown forge values', () => {
        expect(ExternalRefSchema.safeParse({
            ...validPr,
            checks: 'purple'
        }).success).toBe(false)
    })

    it('rejects invalid repo shape', () => {
        expect(ExternalRefSchema.safeParse({ ...validPr, repo: 'not-a-repo' }).success).toBe(false)
        expect(ExternalRefSchema.safeParse({ ...validPr, repo: '/hapi' }).success).toBe(false)
        const overlongRepo = `${'a'.repeat(70)}/${'b'.repeat(71)}`
        expect(ExternalRefSchema.safeParse({
            ...validPr,
            repo: overlongRepo,
            url: `https://github.com/${overlongRepo}/pull/1160`
        }).success).toBe(false)
    })

    it('rejects non-positive PR numbers', () => {
        expect(ExternalRefSchema.safeParse({ ...validPr, number: 0 }).success).toBe(false)
        expect(ExternalRefSchema.safeParse({ ...validPr, number: -1 }).success).toBe(false)
    })

    it('rejects URLs that do not match the declared GitHub PR identity', () => {
        expect(ExternalRefSchema.safeParse({
            ...validPr,
            url: 'https://example.test/phish'
        }).success).toBe(false)
        expect(ExternalRefSchema.safeParse({
            ...validPr,
            url: 'https://github.com/other/repo/pull/1160'
        }).success).toBe(false)
        expect(ExternalRefSchema.safeParse({
            ...validPr,
            url: 'https://github.com/tiann/hapi/pull/999'
        }).success).toBe(false)
    })

    it('rejects unknown kinds', () => {
        expect(ExternalRefSchema.safeParse({ ...validPr, kind: 'gitlab_mr' }).success).toBe(false)
    })
})

describe('MetadataSchema.externalRefs', () => {
    const base = { path: '/tmp', host: 'test' }

    it('accepts optional externalRefs array', () => {
        const parsed = MetadataSchema.safeParse({
            ...base,
            externalRefs: [{
                kind: 'github_pr',
                repo: 'owner/name',
                number: 42,
                url: 'https://github.com/owner/name/pull/42',
                role: 'secondary'
            }]
        })
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.externalRefs).toHaveLength(1)
            expect(parsed.data.externalRefs?.[0]?.number).toBe(42)
        }
    })

    it('rejects malformed externalRefs entries', () => {
        expect(MetadataSchema.safeParse({
            ...base,
            externalRefs: [{ kind: 'github_pr', repo: 'x', number: 1 }]
        }).success).toBe(false)
    })

    it('rejects more than one primary GitHub PR', () => {
        const primaryA = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1,
            url: 'https://github.com/tiann/hapi/pull/1',
            role: 'primary' as const
        }
        const primaryB = {
            ...primaryA,
            number: 2,
            url: 'https://github.com/tiann/hapi/pull/2'
        }
        expect(ExternalRefsSchema.safeParse([primaryA, primaryB]).success).toBe(false)
        expect(MetadataSchema.safeParse({
            ...base,
            externalRefs: [primaryA, primaryB]
        }).success).toBe(false)
    })

    it('rejects duplicate GitHub PR identities including repo casing variants', () => {
        const primary = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'primary' as const
        }
        const duplicateSecondary = {
            kind: 'github_pr' as const,
            repo: 'Tiann/Hapi',
            number: 1163,
            url: 'https://github.com/Tiann/Hapi/pull/1163',
            role: 'secondary' as const
        }
        expect(ExternalRefsSchema.safeParse([primary, duplicateSecondary]).success).toBe(false)
        expect(MetadataSchema.safeParse({
            ...base,
            externalRefs: [primary, duplicateSecondary]
        }).success).toBe(false)
    })

    it('rejects more than MAX_EXTERNAL_REFS entries', () => {
        const refs = Array.from({ length: 33 }, (_, index) => ({
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: index + 1,
            url: `https://github.com/tiann/hapi/pull/${index + 1}`,
            role: 'secondary' as const
        }))
        expect(ExternalRefsSchema.safeParse(refs).success).toBe(false)
    })
})

describe('getPrimaryGithubPrRef', () => {
    it('returns the primary github_pr ref', () => {
        const primary = {
            kind: 'github_pr' as const,
            repo: 'a/b',
            number: 1,
            url: 'https://github.com/a/b/pull/1',
            role: 'primary' as const
        }
        const secondary = {
            kind: 'github_pr' as const,
            repo: 'a/b',
            number: 2,
            url: 'https://github.com/a/b/pull/2',
            role: 'secondary' as const
        }
        expect(getPrimaryGithubPrRef([secondary, primary])).toEqual(primary)
    })

    it('returns null when no primary github_pr exists', () => {
        expect(getPrimaryGithubPrRef(undefined)).toBeNull()
        expect(getPrimaryGithubPrRef([])).toBeNull()
        expect(getPrimaryGithubPrRef([{
            kind: 'github_pr',
            repo: 'a/b',
            number: 9,
            url: 'https://github.com/a/b/pull/9',
            role: 'secondary'
        }])).toBeNull()
    })
})

describe('parseGithubPrInput', () => {
    it('parses owner/repo#N and canonical URLs', () => {
        expect(parseGithubPrInput('tiann/hapi#1162')).toEqual({
            ok: true,
            repo: 'tiann/hapi',
            number: 1162,
            url: 'https://github.com/tiann/hapi/pull/1162'
        })
        expect(parseGithubPrInput('https://github.com/tiann/hapi/pull/1162')).toEqual({
            ok: true,
            repo: 'tiann/hapi',
            number: 1162,
            url: 'https://github.com/tiann/hapi/pull/1162'
        })
    })

    it('rejects non-GitHub or malformed input', () => {
        expect(parseGithubPrInput('').ok).toBe(false)
        expect(parseGithubPrInput('https://gitlab.com/a/b/-/merge_requests/1').ok).toBe(false)
        expect(parseGithubPrInput('not-a-ref').ok).toBe(false)
    })
})

describe('buildGithubPrExternalRef', () => {
    it('builds a canonical primary ref', () => {
        expect(buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1162,
            source: 'agent',
            linkedAt: 42
        })).toEqual({
            kind: 'github_pr',
            repo: 'tiann/hapi',
            number: 1162,
            url: 'https://github.com/tiann/hapi/pull/1162',
            role: 'primary',
            source: 'agent',
            linkedAt: 42
        })
    })
})

describe('upsertGithubPrIntoExternalRefs', () => {
    it('upserting a primary into MAX_EXTERNAL_REFS secondaries exceeds the cap', () => {
        const secondaries = Array.from({ length: 32 }, (_, index) => ({
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: index + 1,
            url: `https://github.com/tiann/hapi/pull/${index + 1}`,
            role: 'secondary' as const
        }))
        const primary = buildGithubPrExternalRef({ repo: 'tiann/hapi', number: 99, role: 'primary' })
        const next = upsertGithubPrIntoExternalRefs(secondaries, primary)
        expect(ExternalRefsSchema.safeParse(next).success).toBe(false)
    })

    it('preserves cached health when re-linking the same PR', () => {
        const existing = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1163,
            source: 'user',
            linkedAt: 100,
            openState: 'open',
            checks: 'pending',
            merge: 'unstable',
            statusCheckedAt: 200,
            estateCode: 'ci_pending'
        })
        const incoming = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1163,
            source: 'agent',
            linkedAt: 300
        })
        expect(upsertGithubPrIntoExternalRefs([existing], incoming)).toEqual([{
            ...existing,
            source: 'agent',
            linkedAt: 300,
            role: 'primary'
        }])
    })

    it('matches the same PR when repo casing differs', () => {
        const existing = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1163,
            source: 'user',
            linkedAt: 100,
            checks: 'pass',
            statusCheckedAt: 200
        })
        const incoming = buildGithubPrExternalRef({
            repo: 'Tiann/HAPI',
            number: 1163,
            source: 'agent',
            linkedAt: 300
        })
        expect(upsertGithubPrIntoExternalRefs([existing], incoming)).toEqual([{
            ...existing,
            source: 'agent',
            linkedAt: 300,
            role: 'primary'
        }])
    })

    it('drops a competing primary when linking a different PR', () => {
        const prior = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 1,
            linkedAt: 1,
            checks: 'pass'
        })
        const next = buildGithubPrExternalRef({
            repo: 'tiann/hapi',
            number: 2,
            linkedAt: 2
        })
        expect(upsertGithubPrIntoExternalRefs([prior], next)).toEqual([next])
    })
})

describe('pr chip display profile', () => {
    const baseRef = buildGithubPrExternalRef({
        repo: 'tiann/hapi',
        number: 1163,
        checks: 'pass',
        merge: 'clean',
        statusCheckedAt: 1_700_000_000_000
    })

    it('uses generic forge labels with no Meta prose by default', () => {
        const display = resolveGithubPrChipDisplay(baseRef, DEFAULT_PR_CHIP_DISPLAY, 1_700_000_000_000)
        expect(display.label).toBe('ready to merge')
        expect(display.emoji).toBe('')
        expect(display.action).toBeUndefined()
        expect(formatGithubPrChipLabel(baseRef, display)).toBe('PR')
    })

    it('lets estateCodes override emoji and action terms', () => {
        const profile = mergePrChipDisplayProfile({
            estateCodes: {
                'babysit.green': {
                    emoji: '✅',
                    tone: 'ok',
                    label: 'clean',
                    action: 'full green — wait on tiann'
                }
            }
        })
        const ref = { ...baseRef, estateCode: 'babysit.green' }
        const display = resolveGithubPrChipDisplay(ref, profile, 1_700_000_000_000)
        expect(display.emoji).toBe('✅')
        expect(display.action).toBe('full green — wait on tiann')
        expect(formatGithubPrChipLabel(ref, display)).toBe('✅')
    })

    it('mutes to ? when statusCheckedAt is older than staleMs', () => {
        const display = resolveGithubPrChipDisplay(
            baseRef,
            DEFAULT_PR_CHIP_DISPLAY,
            1_700_000_000_000 + DEFAULT_PR_CHIP_DISPLAY.staleMs + 1
        )
        expect(display.stale).toBe(true)
        expect(formatGithubPrChipLabel(baseRef, display)).toBe('?')
    })
})
