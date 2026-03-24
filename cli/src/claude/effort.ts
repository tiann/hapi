import type { SessionEffort } from '@/api/types'

export function normalizeClaudeSessionEffort(effort?: string | null): SessionEffort {
    const trimmedEffort = effort?.trim().toLowerCase()
    if (!trimmedEffort || trimmedEffort === 'auto' || trimmedEffort === 'default') {
        return null
    }

    return trimmedEffort
}
