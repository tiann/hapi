import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SkillSummary } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'
import { getRecentSkills } from '@/lib/recent-skills'

function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    const matrix: number[][] = []
    for (let i = 0; i <= b.length; i++) matrix[i] = [i]
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        }
    }
    return matrix[b.length][a.length]
}

export function useSkills(
    api: ApiClient | null,
    sessionId: string | null
): {
    skills: SkillSummary[]
    isLoading: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
} {
    const resolvedSessionId = sessionId ?? 'unknown'

    const query = useQuery({
        queryKey: queryKeys.skills(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSkills(sessionId)
        },
        enabled: Boolean(api && sessionId),
        staleTime: Infinity,
        gcTime: 30 * 60 * 1000,
        retry: false,
    })

    const skills = useMemo(() => {
        if (query.data?.success && query.data.skills) {
            return query.data.skills
        }
        return []
    }, [query.data])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        const recent = getRecentSkills()
        const getRecency = (name: string) => recent[name] ?? 0
        const searchTerm = queryText.startsWith('$')
            ? queryText.slice(1).toLowerCase()
            : queryText.toLowerCase()

        if (!searchTerm) {
            return [...skills]
                .sort((a, b) => getRecency(b.name) - getRecency(a.name) || a.name.localeCompare(b.name))
                .map((skill) => ({
                    key: `$${skill.name}`,
                    text: `$${skill.name}`,
                    label: `$${skill.name}`,
                    description: skill.description,
                    source: 'builtin'
                }))
        }

        const maxDistance = Math.max(2, Math.floor(searchTerm.length / 2))
        return skills
            .map(skill => {
                const name = skill.name.toLowerCase()
                let score: number
                if (name === searchTerm) score = 0
                else if (name.startsWith(searchTerm)) score = 1
                else if (name.includes(searchTerm)) score = 2
                else {
                    const dist = levenshteinDistance(searchTerm, name)
                    score = dist <= maxDistance ? 3 + dist : Infinity
                }
                return { skill, score, recency: getRecency(skill.name) }
            })
            .filter(item => item.score < Infinity)
            .sort((a, b) => a.score - b.score || b.recency - a.recency || a.skill.name.localeCompare(b.skill.name))
            .map(({ skill }) => ({
                key: `$${skill.name}`,
                text: `$${skill.name}`,
                label: `$${skill.name}`,
                description: skill.description,
                source: 'builtin'
            }))
    }, [skills])

    return {
        skills,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load skills' : null,
        getSuggestions,
    }
}
