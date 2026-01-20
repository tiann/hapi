const RECENT_SKILLS_KEY = 'hapi-recent-skills'
const MAX_RECENT_SKILLS = 200

type RecentSkillsMap = Record<string, number>

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

export function getRecentSkills(): RecentSkillsMap {
    if (typeof window === 'undefined') return {}
    try {
        const raw = localStorage.getItem(RECENT_SKILLS_KEY)
        if (!raw) return {}
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') return {}

        const record = parsed as Record<string, unknown>
        const result: RecentSkillsMap = {}
        for (const [key, value] of Object.entries(record)) {
            if (typeof key !== 'string' || key.trim().length === 0) continue
            if (typeof value !== 'number' || !Number.isFinite(value)) continue
            result[key] = value
        }
        return result
    } catch {
        return {}
    }
}

export function markSkillUsed(skillName: string): void {
    const name = skillName.trim()
    if (!name) return
    if (typeof window === 'undefined') return

    try {
        const recent = getRecentSkills()
        recent[name] = Date.now()

        const entries = Object.entries(recent)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_RECENT_SKILLS)

        const next: RecentSkillsMap = Object.fromEntries(entries)
        localStorage.setItem(RECENT_SKILLS_KEY, JSON.stringify(next))
    } catch {
        // Ignore storage errors
    }
}

