import { isObject } from '@hapi/protocol'
import { extractSessionCitationIds, normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import type { ChatToolCall } from '@/chat/types'
import { getInputStringAny } from '@/lib/toolInputUtils'

export const HAPI_PEER_TOOL_NAMES = ['spawn_peer', 'ping_peer', 'inspect_peer', 'list_peers'] as const
export type HapiPeerToolName = typeof HAPI_PEER_TOOL_NAMES[number]

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SPAWNED_SESSION_RE = /^\s*Spawned\s+([A-Za-z0-9_-]{8,})(?=\s|$)/
const PING_PEER_HEADER_RE = /^\s*(?:Accepted\s+for|(?:steered|invoked)\s+to)\s+([A-Za-z0-9_-]{8,})(?=\s|$)/i
const INSPECT_PEER_HEADER_RE = /^\s*sessionId:\s+([A-Za-z0-9_-]{8,})(?=\s|$)/
const PEER_ERROR_PREFIX_RE = /^\s*Failed\s+to\s+(?:ping|inspect|spawn)\s+peer:/i

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

function extractStructuredSessionId(result: unknown, depth: number = 0): string | null {
    if (depth > 5 || result === null || result === undefined) return null
    if (Array.isArray(result)) {
        for (const item of result) {
            const nested = extractStructuredSessionId(item, depth + 1)
            if (nested) return nested
        }
        return null
    }
    if (isObject(result)) {
        if (typeof result.sessionId === 'string') {
            const trimmed = result.sessionId.trim()
            if (EXACT_UUID_RE.test(trimmed)) {
                return trimmed
            }
        }
        for (const key of ['structuredContent', 'result', 'output', 'data', 'content'] as const) {
            const nested = extractStructuredSessionId(result[key], depth + 1)
            if (nested) return nested
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
        for (const key of ['text', 'content', 'result', 'output', 'message', 'error'] as const) {
            const nested = flattenResultText(result[key], depth + 1)
            if (nested) return nested
        }
    }
    return ''
}

function isErrorResultEnvelope(result: unknown, depth: number = 0): boolean {
    if (depth > 5 || result === null || result === undefined) return false
    if (Array.isArray(result)) {
        return result.some((item) => isErrorResultEnvelope(item, depth + 1))
    }
    if (isObject(result)) {
        if (result.isError === true || result.is_error === true) return true
        if (typeof result.error === 'string' && result.error.trim().length > 0) return true
        if (isObject(result.error)) return true
        for (const key of ['result', 'output', 'data'] as const) {
            if (isErrorResultEnvelope(result[key], depth + 1)) return true
        }
    }
    return false
}

function isFailedPeerToolCall(
    result: unknown,
    resultText: string,
    state?: ChatToolCall['state']
): boolean {
    return state === 'error'
        || isErrorResultEnvelope(result)
        || (resultText.length > 0 && PEER_ERROR_PREFIX_RE.test(resultText))
}

export function extractSpawnedSessionId(
    result: unknown,
    state?: ChatToolCall['state']
): string | null {
    const text = flattenResultText(result)
    if (text) {
        const spawned = SPAWNED_SESSION_RE.exec(text)
        if (spawned?.[1]) return spawned[1]
    }
    const structured = extractStructuredSessionId(result)
    if (structured) return structured
    if (isFailedPeerToolCall(result, text, state)) return null
    if (!text) return null
    const cited = extractSessionCitationIds(text)[0]
    if (cited) return cited
    const uuid = UUID_RE.exec(text)
    return uuid?.[1] ?? null
}

export function extractPeerTargetSessionId(
    toolName: string,
    input: unknown,
    result: unknown,
    state?: ChatToolCall['state']
): string | null {
    const peerTool = parsePeerToolName(toolName)
    if (!peerTool || peerTool === 'list_peers') return null

    if (peerTool === 'spawn_peer') {
        return extractSpawnedSessionId(result, state)
    }

    const resultText = flattenResultText(result)
    if (resultText) {
        const headerRe = peerTool === 'ping_peer' ? PING_PEER_HEADER_RE : INSPECT_PEER_HEADER_RE
        const headerMatch = headerRe.exec(resultText)
        if (headerMatch?.[1]) return headerMatch[1]
    }

    const structured = extractStructuredSessionId(result)
    if (structured) return structured

    if (isFailedPeerToolCall(result, resultText, state)) return null

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
