import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@/types/api'
import { searchSkills } from './skill-search'

function skill(overrides: Partial<SkillSummary>): SkillSummary {
    return {
        name: 'review',
        description: 'Review code changes.',
        path: '/repo/.agents/skills/review/SKILL.md',
        scope: 'repo',
        ...overrides,
    }
}

describe('skill search', () => {
    it('returns all skills for an empty query in scanner order', () => {
        const results = searchSkills([
            skill({ name: 'review', path: '/repo/review/SKILL.md' }),
            skill({ name: 'compound-engineering:ce-plan', path: '/plugin/ce-plan/SKILL.md', scope: 'plugin' }),
        ], '$')

        expect(results.map((result) => result.text)).toEqual([
            '$review',
            '$compound-engineering:ce-plan',
        ])
    })

    it('matches plugin skills by local skill name', () => {
        const results = searchSkills([
            skill({ name: 'review' }),
            skill({
                name: 'compound-engineering:ce-brainstorm',
                description: 'Explore requirements before planning implementation work.',
                path: '/plugin/ce-brainstorm/SKILL.md',
                scope: 'plugin',
                pluginName: 'compound-engineering',
            }),
            skill({
                name: 'compound-engineering:ce-plan',
                description: 'Create structured implementation plans.',
                path: '/plugin/ce-plan/SKILL.md',
                scope: 'plugin',
                pluginName: 'compound-engineering',
            }),
        ], '$plan')

        expect(results.map((result) => result.text)).toEqual([
            '$compound-engineering:ce-plan',
            '$compound-engineering:ce-brainstorm',
        ])
    })

    it('matches plugin skills by plugin name', () => {
        const results = searchSkills([
            skill({ name: 'drawio', path: '/user/drawio/SKILL.md', scope: 'user' }),
            skill({
                name: 'compound-engineering:ce-work',
                description: 'Execute work.',
                path: '/plugin/ce-work/SKILL.md',
                scope: 'plugin',
                pluginName: 'compound-engineering',
            }),
        ], 'compound')

        expect(results.map((result) => result.text)).toEqual(['$compound-engineering:ce-work'])
    })

    it('keeps duplicate names distinct by path', () => {
        const results = searchSkills([
            skill({ name: 'review', path: '/repo/review/SKILL.md', scope: 'repo' }),
            skill({ name: 'review', path: '/user/review/SKILL.md', scope: 'user' }),
        ], '$review')

        expect(results.map((result) => result.key)).toEqual([
            '/repo/review/SKILL.md:$review',
            '/user/review/SKILL.md:$review',
        ])
    })

    it('returns an empty array when no skills match', () => {
        expect(searchSkills([
            skill({ name: 'review' }),
        ], 'zzzz')).toEqual([])
    })

    it('maps skills with empty descriptions to displayable results', () => {
        const results = searchSkills([
            skill({ name: 'no-description', description: '', path: '/user/no-description/SKILL.md', scope: 'user' }),
        ], 'no-description')

        expect(results[0]).toMatchObject({
            text: '$no-description',
            description: 'user - /user/no-description/SKILL.md',
        })
    })
})
