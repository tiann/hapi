const CODEX_IMPORTED_SESSIONS_STORAGE_KEY = 'hapi.codexImportedSessions'
const CODEX_IMPORTED_SESSIONS_EVENT = 'hapi:codex-imported-sessions-updated'

type CodexImportedSessionsMap = Record<string, number>

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function dispatchCodexImportedSessionsChanged(): void {
    if (!isBrowser()) return
    window.dispatchEvent(new CustomEvent(CODEX_IMPORTED_SESSIONS_EVENT))
}

export function readCodexImportedSessions(): CodexImportedSessionsMap {
    if (!isBrowser()) return {}
    try {
        const raw = localStorage.getItem(CODEX_IMPORTED_SESSIONS_STORAGE_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {}
        }

        const result: CodexImportedSessionsMap = {}
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

function writeCodexImportedSessions(map: CodexImportedSessionsMap): void {
    if (!isBrowser()) return
    localStorage.setItem(CODEX_IMPORTED_SESSIONS_STORAGE_KEY, JSON.stringify(map))
    dispatchCodexImportedSessionsChanged()
}

export function markCodexSessionsImported(codexSessionIds: string[], importedAt = Date.now()): void {
    if (!isBrowser() || codexSessionIds.length === 0) return

    // 中文注释：以 Codex thread ID 为 key 记录导入时间，便于会话列表把时间文案切换成“从 Codex 客户端导入”。
    const next = readCodexImportedSessions()
    for (const codexSessionId of codexSessionIds) {
        const trimmed = codexSessionId.trim()
        if (trimmed) {
            next[trimmed] = importedAt
        }
    }
    writeCodexImportedSessions(next)
}

export function clearCodexImportedSession(codexSessionId: string | null | undefined): void {
    if (!isBrowser() || !codexSessionId) return

    const next = readCodexImportedSessions()
    if (!(codexSessionId in next)) return

    // 中文注释：当用户已经在 Hapi 内继续这个会话后，移除导入标记，列表时间恢复为普通“xx 分钟前”。
    delete next[codexSessionId]
    writeCodexImportedSessions(next)
}

export function getCodexImportedAt(codexSessionId: string | null | undefined): number | null {
    if (!codexSessionId) return null
    const importedAt = readCodexImportedSessions()[codexSessionId]
    return typeof importedAt === 'number' && Number.isFinite(importedAt) ? importedAt : null
}

export function subscribeCodexImportedSessions(onChange: () => void): () => void {
    if (!isBrowser()) {
        return () => {}
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === CODEX_IMPORTED_SESSIONS_STORAGE_KEY) {
            onChange()
        }
    }
    const handleCustomEvent = () => {
        onChange()
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(CODEX_IMPORTED_SESSIONS_EVENT, handleCustomEvent)
    return () => {
        window.removeEventListener('storage', handleStorage)
        window.removeEventListener(CODEX_IMPORTED_SESSIONS_EVENT, handleCustomEvent)
    }
}
