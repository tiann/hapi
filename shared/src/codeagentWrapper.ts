import { isObject } from './utils'

export const CODEAGENT_WRAPPER_BACKENDS = [
    'codex',
    'antigravity',
    'claude',
    'gemini',
    'grok',
    'kimi',
    'opencode',
    'pi',
] as const

export type CodeagentWrapperBackend = (typeof CODEAGENT_WRAPPER_BACKENDS)[number]

export type ParsedCodeagentWrapperCommand = {
    backend: CodeagentWrapperBackend | null
    flavor: string | null
    role: string | null
    resumedSessionId: string | null
    isParallel: boolean
}

const WRAPPER_BINARY_RE = /(?:^|[\s"'/\\])codeagent-wrapper(?:\.exe)?(?=\s|["']|$)/
const WRAPPER_SIGNAL_RE = /(?:--backend(?:=|\s+)\S+|(?:^|\s)--parallel(?:\s|$)|\bresume\s+\S+)/
const BACKEND_FLAG_RE = /--backend(?:=|\s+)["']?([a-z0-9_-]+)["']?/i
const PARALLEL_FLAG_RE = /(?:^|\s)--parallel(?:\s|$)/
const ROLE_FILE_RE = /ROLE_FILE:\s*\S*?[/\\]([a-z0-9_-]+)\.md\b/i
const RESUME_SESSION_RE = /\bresume\s+["']?([A-Za-z0-9_-]{6,})["']?/
const WRAPPER_SESSION_FOOTER_RE = /(?:^|\r?\n)---\r?\n(?:SESSION_ID|Session-ID):\s*([A-Za-z0-9_-]{8,})\s*(?=\r?\n|$)/g

const BACKEND_SET = new Set<string>(CODEAGENT_WRAPPER_BACKENDS)

const NATIVE_SESSION_ID_FIELDS = [
    'claudeSessionId',
    'codexSessionId',
    'agySessionId',
    'opencodeSessionId',
    'piSessionId',
    'grokSessionId',
    'kimiSessionId',
    'geminiSessionId',
    'cursorSessionId',
    'copilotSessionId',
    'dshSessionId',
    'agentSessionId',
] as const

/**
 * Maps a `codeagent-wrapper` backend identifier onto HAPI's canonical flavor name.
 */
export function mapWrapperBackendToHapiFlavor(backend: string): string {
    const normalized = backend.trim().toLowerCase()
    if (normalized === 'antigravity') return 'agy'
    return normalized
}

/**
 * Parses a shell command that invokes `codeagent-wrapper` (used by CCG and OpenSlime).
 * Requires both the wrapper executable token and a wrapper flag/subcommand so plain file
 * reads or directory listings mentioning `codeagent-wrapper` do not false-match.
 */
export function parseCodeagentWrapperCommand(
    command: string | null | undefined
): ParsedCodeagentWrapperCommand | null {
    if (!command) return null
    if (!WRAPPER_BINARY_RE.test(command) || !WRAPPER_SIGNAL_RE.test(command)) {
        return null
    }

    const backendMatch = BACKEND_FLAG_RE.exec(command)
    const rawBackend = backendMatch?.[1]?.toLowerCase() ?? null
    const backend = rawBackend && BACKEND_SET.has(rawBackend)
        ? (rawBackend as CodeagentWrapperBackend)
        : null
    const roleMatch = ROLE_FILE_RE.exec(command)
    const resumeMatch = RESUME_SESSION_RE.exec(command)

    return {
        backend,
        flavor: rawBackend ? mapWrapperBackendToHapiFlavor(rawBackend) : null,
        role: roleMatch?.[1]?.toLowerCase() ?? null,
        resumedSessionId: resumeMatch?.[1] ?? null,
        isParallel: PARALLEL_FLAG_RE.test(command),
    }
}

/**
 * Extracts native agent session IDs emitted by `codeagent-wrapper`'s footer (`---\nSESSION_ID: ...`).
 * Matches only the canonical footer delimiter so prose mentions or source files do not create false links.
 */
export function extractCodeagentWrapperSessionIds(
    output: string | null | undefined
): string[] {
    if (!output) return []
    if (!output.includes('SESSION_ID:') && !output.includes('Session-ID:')) return []

    const ids: string[] = []
    const seen = new Set<string>()
    WRAPPER_SESSION_FOOTER_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = WRAPPER_SESSION_FOOTER_RE.exec(output)) !== null) {
        const id = match[1]?.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }
    return ids
}

/**
 * Collects all native runtime session IDs stored on a HAPI session metadata object.
 */
export function getNativeAgentSessionIds(metadata: unknown): string[] {
    if (!isObject(metadata)) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const key of NATIVE_SESSION_ID_FIELDS) {
        const value = metadata[key]
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        ids.push(trimmed)
    }
    return ids
}
