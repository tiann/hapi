const CLAUDE_IMPORTED_SESSIONS_STORAGE_KEY = 'hapi.claudeImportedSessions'
const CLAUDE_IMPORTED_SESSIONS_EVENT = 'hapi:claude-imported-sessions-updated'

type ClaudeImportedSessionsMap = Record<string, number>

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function dispatchClaudeImportedSessionsChanged(): void {
    if (!isBrowser()) return
    window.dispatchEvent(new CustomEvent(CLAUDE_IMPORTED_SESSIONS_EVENT))
}

export function readClaudeImportedSessions(): ClaudeImportedSessionsMap {
    if (!isBrowser()) return {}
    try {
        const raw = localStorage.getItem(CLAUDE_IMPORTED_SESSIONS_STORAGE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {}
        }

        const result: ClaudeImportedSessionsMap = {}
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof key === 'string' && typeof value === 'number' && Number.isFinite(value)) {
                result[key] = value
            }
        }
        return result
    } catch {
        return {}
    }
}

function writeClaudeImportedSessions(map: ClaudeImportedSessionsMap): void {
    if (!isBrowser()) return
    localStorage.setItem(CLAUDE_IMPORTED_SESSIONS_STORAGE_KEY, JSON.stringify(map))
    dispatchClaudeImportedSessionsChanged()
}

export function markClaudeSessionsImported(claudeSessionIds: string[], importedAt = Date.now()): void {
    if (!isBrowser() || claudeSessionIds.length === 0) return

    // 中文注释：以 Claude session ID 为 key 记录导入时间，便于会话列表把时间文案切换成“从 Claude 导入”。
    const next = readClaudeImportedSessions()
    for (const claudeSessionId of claudeSessionIds) {
        const trimmed = claudeSessionId.trim()
        if (trimmed) {
            next[trimmed] = importedAt
        }
    }
    writeClaudeImportedSessions(next)
}

export function clearClaudeImportedSession(claudeSessionId: string | null | undefined): void {
    if (!isBrowser() || !claudeSessionId) return

    const next = readClaudeImportedSessions()
    if (!(claudeSessionId in next)) return

    // 中文注释：当用户已经在 Hapi 内继续这个会话后，移除导入标记，列表时间恢复为普通“xx 分钟前”。
    delete next[claudeSessionId]
    writeClaudeImportedSessions(next)
}

export function getClaudeImportedAt(claudeSessionId: string | null | undefined): number | null {
    if (!claudeSessionId) return null
    const importedAt = readClaudeImportedSessions()[claudeSessionId]
    return typeof importedAt === 'number' && Number.isFinite(importedAt) ? importedAt : null
}

export function subscribeClaudeImportedSessions(onChange: () => void): () => void {
    if (!isBrowser()) {
        return () => {}
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === CLAUDE_IMPORTED_SESSIONS_STORAGE_KEY) {
            onChange()
        }
    }
    const handleCustomEvent = () => {
        onChange()
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(CLAUDE_IMPORTED_SESSIONS_EVENT, handleCustomEvent)
    return () => {
        window.removeEventListener('storage', handleStorage)
        window.removeEventListener(CLAUDE_IMPORTED_SESSIONS_EVENT, handleCustomEvent)
    }
}
