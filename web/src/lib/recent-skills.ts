import type { SkillSummary } from '@/types/api'
import type { SkillSearchResult } from '@/lib/skill-search'

export const RECENT_SKILLS_KEY = 'hapi-recent-skills'
export const MAX_RECENT_SKILLS = 5

export type RecentSkillEntry = {
    key: string
    name: string
    description: string
    path: string
    scope: SkillSummary['scope']
    pluginName?: string
    pluginPath?: string
    usedAt: number
}

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

function cleanEntry(value: unknown): RecentSkillEntry | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.key !== 'string' || record.key.trim().length === 0) return null
    if (typeof record.name !== 'string' || record.name.trim().length === 0) return null
    if (typeof record.path !== 'string') return null
    if (!['repo', 'user', 'plugin', 'admin'].includes(String(record.scope))) return null
    if (typeof record.usedAt !== 'number' || !Number.isFinite(record.usedAt)) return null

    return {
        key: record.key,
        name: record.name,
        description: typeof record.description === 'string' ? record.description : '',
        path: record.path,
        scope: record.scope as SkillSummary['scope'],
        pluginName: typeof record.pluginName === 'string' ? record.pluginName : undefined,
        pluginPath: typeof record.pluginPath === 'string' ? record.pluginPath : undefined,
        usedAt: record.usedAt,
    }
}

function legacyMapToEntries(value: unknown): RecentSkillEntry[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []

    return Object.entries(value as Record<string, unknown>)
        .flatMap(([name, usedAt]) => {
            const cleanName = name.trim()
            if (!cleanName) return []
            if (typeof usedAt !== 'number' || !Number.isFinite(usedAt)) return []
            return [{
                key: `legacy:$${cleanName}`,
                name: cleanName,
                description: '',
                path: '',
                scope: 'user' as const,
                usedAt,
            }]
        })
        .sort((a, b) => b.usedAt - a.usedAt)
        .slice(0, MAX_RECENT_SKILLS)
}

export function skillToRecentEntry(suggestion: SkillSearchResult, usedAt = Date.now()): RecentSkillEntry {
    return {
        key: suggestion.key,
        name: suggestion.skill.name,
        description: suggestion.skill.description,
        path: suggestion.skill.path,
        scope: suggestion.skill.scope,
        pluginName: suggestion.skill.pluginName,
        pluginPath: suggestion.skill.pluginPath,
        usedAt,
    }
}

export function recentEntryToSkill(entry: RecentSkillEntry): SkillSummary {
    return {
        name: entry.name,
        description: entry.description,
        path: entry.path,
        scope: entry.scope,
        pluginName: entry.pluginName,
        pluginPath: entry.pluginPath,
    }
}

export function getRecentSkills(): RecentSkillEntry[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = localStorage.getItem(RECENT_SKILLS_KEY)
        if (!raw) return []
        const parsed = safeParseJson(raw)
        if (!parsed) return []

        if (Array.isArray(parsed)) {
            return parsed
                .map(cleanEntry)
                .filter((entry): entry is RecentSkillEntry => Boolean(entry))
                .sort((a, b) => b.usedAt - a.usedAt)
                .slice(0, MAX_RECENT_SKILLS)
        }

        return legacyMapToEntries(parsed)
    } catch {
        return []
    }
}

export function markSkillUsed(suggestion: SkillSearchResult): void {
    if (typeof window === 'undefined') return

    try {
        const nextEntry = skillToRecentEntry(suggestion)
        const next = [
            nextEntry,
            ...getRecentSkills().filter((entry) => entry.key !== nextEntry.key)
        ].slice(0, MAX_RECENT_SKILLS)

        localStorage.setItem(RECENT_SKILLS_KEY, JSON.stringify(next))
    } catch {
        // Ignore storage errors
    }
}
