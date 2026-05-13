import type { SkillSummary } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'

export interface SkillSearchResult {
    key: string
    text: string
    label: string
    description: string
    skill: SkillSummary
    source: SkillSummary['scope']
    path: string
    scope: SkillSummary['scope']
}

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

export function normalizeSkillQuery(queryText: string): string {
    return queryText.startsWith('$')
        ? queryText.slice(1).trim().toLowerCase()
        : queryText.trim().toLowerCase()
}

function localSkillName(skill: SkillSummary): string {
    const separatorIndex = skill.name.lastIndexOf(':')
    return separatorIndex >= 0 ? skill.name.slice(separatorIndex + 1) : skill.name
}

function searchableValues(skill: SkillSummary): Array<{ value: string; weight: number }> {
    return [
        { value: skill.name, weight: 0 },
        { value: localSkillName(skill), weight: 0 },
        { value: skill.pluginName, weight: 1 },
        { value: skill.scope, weight: 4 },
        { value: skill.description, weight: 10 },
        { value: skill.path, weight: 12 },
    ].filter((entry): entry is { value: string; weight: number } => Boolean(entry.value))
        .map((entry) => ({ ...entry, value: entry.value.toLowerCase() }))
}

function scoreSkill(skill: SkillSummary, searchTerm: string): number {
    if (!searchTerm) {
        return 0
    }

    const maxDistance = Math.max(2, Math.floor(searchTerm.length / 2))
    let bestScore = Infinity

    for (const { value, weight } of searchableValues(skill)) {
        let score: number
        if (value === searchTerm) score = 0
        else if (value.startsWith(searchTerm)) score = 1
        else if (value.includes(searchTerm)) score = 2
        else {
            const dist = levenshteinDistance(searchTerm, value)
            score = dist <= maxDistance ? 3 + dist : Infinity
        }

        bestScore = Math.min(bestScore, score + weight)
    }

    return bestScore
}

export function formatSkillDescription(skill: SkillSummary): string {
    const source = skill.pluginName
        ? `${skill.scope}:${skill.pluginName}`
        : skill.scope
    const details = `${source} - ${skill.path}`
    if (!skill.description) {
        return details
    }
    return `${skill.description} (${details})`
}

export function skillToSearchResult(skill: SkillSummary): SkillSearchResult {
    return {
        key: `${skill.path}:$${skill.name}`,
        text: `$${skill.name}`,
        label: `$${skill.name}`,
        description: formatSkillDescription(skill),
        skill,
        source: skill.scope,
        path: skill.path,
        scope: skill.scope,
    }
}

export function searchSkills(skills: readonly SkillSummary[], queryText: string): SkillSearchResult[] {
    const searchTerm = normalizeSkillQuery(queryText)
    if (!searchTerm) {
        return skills.map(skillToSearchResult)
    }

    return skills
        .map((skill, index) => ({
            skill,
            index,
            score: scoreSkill(skill, searchTerm),
        }))
        .filter((item) => item.score < Infinity)
        .sort((a, b) => (
            a.score - b.score
            || a.skill.name.localeCompare(b.skill.name)
            || a.skill.path.localeCompare(b.skill.path)
            || a.index - b.index
        ))
        .map(({ skill }) => skillToSearchResult(skill))
}

export function skillSearchResultsToSuggestions(results: readonly SkillSearchResult[]): Suggestion[] {
    return results.map((result) => ({
        key: result.key,
        text: result.text,
        label: result.label,
        description: result.description,
        source: result.source,
        path: result.path,
        scope: result.scope,
    }))
}
