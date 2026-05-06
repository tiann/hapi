import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillSummary } from '@/types/api'
import { skillToSearchResult } from './skill-search'
import {
    getRecentSkills,
    markSkillUsed,
    RECENT_SKILLS_KEY,
} from './recent-skills'

function skill(overrides: Partial<SkillSummary>): SkillSummary {
    return {
        name: 'review',
        description: 'Review code changes.',
        path: '/repo/review/SKILL.md',
        scope: 'repo',
        ...overrides,
    }
}

function mark(skillSummary: SkillSummary): void {
    markSkillUsed(skillToSearchResult(skillSummary))
}

describe('recent skills', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.useRealTimers()
    })

    it('keeps only the five most recent skills in order', () => {
        vi.useFakeTimers()

        for (let i = 0; i < 6; i++) {
            vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i))
            mark(skill({
                name: `skill-${i}`,
                path: `/repo/skill-${i}/SKILL.md`,
            }))
        }

        expect(getRecentSkills().map((entry) => entry.name)).toEqual([
            'skill-5',
            'skill-4',
            'skill-3',
            'skill-2',
            'skill-1',
        ])
    })

    it('moves an existing skill to the top without duplicating it', () => {
        vi.useFakeTimers()
        const review = skill({ name: 'review', path: '/repo/review/SKILL.md' })
        const plan = skill({ name: 'plan', path: '/repo/plan/SKILL.md' })

        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1))
        mark(review)
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 2))
        mark(plan)
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 3))
        mark(review)

        expect(getRecentSkills().map((entry) => entry.name)).toEqual(['review', 'plan'])
    })

    it('keeps same-name skills distinct by path', () => {
        mark(skill({ name: 'review', path: '/repo/review/SKILL.md', scope: 'repo' }))
        mark(skill({ name: 'review', path: '/user/review/SKILL.md', scope: 'user' }))

        expect(getRecentSkills().map((entry) => `${entry.scope}:${entry.path}`)).toEqual([
            'user:/user/review/SKILL.md',
            'repo:/repo/review/SKILL.md',
        ])
    })

    it('returns an empty list for corrupted storage', () => {
        localStorage.setItem(RECENT_SKILLS_KEY, 'not-json')

        expect(getRecentSkills()).toEqual([])
    })

    it('tolerates legacy name timestamp storage', () => {
        localStorage.setItem(RECENT_SKILLS_KEY, JSON.stringify({
            review: 3,
            plan: 4,
        }))

        expect(getRecentSkills().map((entry) => entry.name)).toEqual(['plan', 'review'])
    })

    it('ignores storage write failures', () => {
        const originalSetItem = localStorage.setItem
        localStorage.setItem = vi.fn(() => {
            throw new Error('storage unavailable')
        })

        expect(() => mark(skill({ name: 'review' }))).not.toThrow()

        localStorage.setItem = originalSetItem
    })
})
