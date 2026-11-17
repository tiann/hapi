import { extractCodeagentWrapperSessionIds, isObject, parseCodeagentWrapperCommand, type ParsedCodeagentWrapperCommand } from '@hapi/protocol'
import { extractSessionCitationIds, normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import { getInputStringAny } from '@/lib/toolInputUtils'

export const HAPI_PEER_TOOL_NAMES = ['spawn_peer', 'ping_peer', 'inspect_peer', 'list_peers'] as const
export type HapiPeerToolName = typeof HAPI_PEER_TOOL_NAMES[number]

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const SPAWNED_SESSION_RE = /\bSpawned\s+([A-Za-z0-9_-]{8,})\b/

export function parsePeerToolName(toolName: string): HapiPeerToolName | null {
    const normalized = toolName.trim()
    for (const candidate of HAPI_PEER_TOOL_NAMES) {
        if (
            normalized === candidate
            || normalized === `mcp__hapi__${candidate}`
            || normalized === `functions.hapi__${candidate}`
            || normalized === `hapi_${candidate}`
        ) {
            return candidate
        }
    }
    return null
}

function flattenResultText(result: unknown, depth: number = 0): string {
    if (depth > 5 || result === null || result === undefined) return ''
    if (typeof result === 'string') return result
    if (Array.isArray(result)) {
        return result.map((item) => flattenResultText(item, depth + 1)).filter(Boolean).join('\n')
    }
    if (isObject(result)) {
        if (typeof result.sessionId === 'string') return result.sessionId
        for (const key of ['text', 'content', 'result', 'output', 'message', 'error'] as const) {
            const nested = flattenResultText(result[key], depth + 1)
            if (nested) return nested
        }
    }
    return ''
}

export function extractSpawnedSessionId(result: unknown): string | null {
    const text = flattenResultText(result)
    if (!text) return null
    const spawned = SPAWNED_SESSION_RE.exec(text)
    if (spawned?.[1]) return spawned[1]
    const cited = extractSessionCitationIds(text)[0]
    if (cited) return cited
    const uuid = UUID_RE.exec(text)
    return uuid?.[1] ?? null
}

export function extractPeerTargetSessionId(
    toolName: string,
    input: unknown,
    result: unknown
): string | null {
    const peerTool = parsePeerToolName(toolName)
    if (!peerTool || peerTool === 'list_peers') return null

    if (peerTool === 'spawn_peer') {
        return extractSpawnedSessionId(result)
    }

    const resultText = flattenResultText(result)
    if (resultText) {
        const cited = extractSessionCitationIds(resultText)[0]
        if (cited) return cited
        const uuid = UUID_RE.exec(resultText)
        if (uuid?.[1]) return uuid[1]
    }

    const rawTarget = getInputStringAny(input, ['sessionIdPrefix', 'sessionId', 'session_id'])
    if (!rawTarget) return null
    const normalized = normalizeSessionIdPrefix(rawTarget)
    if (!normalized) return null
    return UUID_RE.test(normalized) ? normalized : null
}

const SHELL_TOOL_NAMES = new Set([
    'bash',
    'codexbash',
    'shell',
    'shell_command',
    'run_shell_command',
    'run_terminal_cmd',
    'exec_command',
    'functions.exec_command',
    'execute',
    'terminal',
])

export type ParsedWrapperToolInvocation = ParsedCodeagentWrapperCommand & {
    label: string
    nativeSessionId: string | null
    description: string | null
}

function getWrapperShellCommand(input: unknown): string | string[] | null {
    const command = getInputStringAny(input, ['command', 'cmd'])
    if (command) return command
    if (!isObject(input) || !Array.isArray(input.command)) return null
    const parts = input.command.filter((part): part is string => typeof part === 'string')
    return parts.length > 0 ? parts : null
}

export function parseWrapperToolInvocation(
    toolName: string,
    input: unknown,
    result?: unknown,
    nativeKind?: string | null
): ParsedWrapperToolInvocation | null {
    const normalized = toolName.trim().toLowerCase()
    if (normalized.startsWith('mcp__')) return null
    const command = getWrapperShellCommand(input)
    if (!command) return null

    const isShellTool = SHELL_TOOL_NAMES.has(normalized)
        || nativeKind === 'execute'
        || (typeof command === 'string' && command === toolName.trim())
        || normalized.startsWith('codeagent-wrapper')
    if (!isShellTool) return null

    const parsed = parseCodeagentWrapperCommand(command)
    if (!parsed) return null

    const spawnedIds = extractCodeagentWrapperSessionIds(flattenResultText(result))
    const nativeSessionId = spawnedIds[0] ?? parsed.resumedSessionId ?? null
    const label = parsed.backend
        ? (parsed.role ? `${parsed.backend} · ${parsed.role}` : parsed.backend)
        : 'codeagent-wrapper'

    return {
        ...parsed,
        label,
        nativeSessionId,
        description: getInputStringAny(input, ['description']),
    }
}
