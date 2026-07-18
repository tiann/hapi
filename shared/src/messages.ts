import { isObject } from './utils'
import { ExecutionControlSchema, type ExecutionControl } from './schemas'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

const VISIBLE_CLAUDE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary'
])

export const CODEX_DESKTOP_SYNC_SOURCE = 'codex-desktop-sync'
export const CODEX_DESKTOP_SYNC_LOCAL_ID_PREFIX = 'codex:'

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

export function isClaudeChatVisibleSystemSubtype(subtype: unknown): subtype is string {
    return typeof subtype === 'string' && VISIBLE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)
}

export function isClaudeChatVisibleMessage(message: { type: unknown; subtype?: unknown }): boolean {
    if (message.type === 'rate_limit_event') {
        return false
    }

    if (message.type !== 'system') {
        return true
    }

    return isClaudeChatVisibleSystemSubtype(message.subtype)
}

function extractAllTextBlocks(content: unknown): string | null {
    if (!Array.isArray(content) || content.length === 0) {
        return null
    }

    const textParts: string[] = []
    for (const block of content) {
        if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
            return null
        }
        textParts.push(block.text)
    }
    return textParts.join('\n\n')
}

export function extractAgentOutputUserText(content: unknown): string | null {
    if (!isObject(content) || content.type !== 'output') {
        return null
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'user') {
        return null
    }
    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) {
        return null
    }
    if (!isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) {
        return null
    }
    if (Boolean(data.isSidechain)) {
        return null
    }

    const message = isObject(data.message) ? data.message : null
    return message ? extractAllTextBlocks(message.content) : null
}

export function isNonblankAgentOutputUserTurnStart(content: unknown): boolean {
    const text = extractAgentOutputUserText(content)
    return text !== null && text.trim().length > 0
}

export function isCodexDesktopSyncMessageEnvelope(message: {
    localId?: string | null
    content: unknown
}): boolean {
    if (typeof message.localId === 'string' && message.localId.startsWith(CODEX_DESKTOP_SYNC_LOCAL_ID_PREFIX)) {
        return true
    }

    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return false
    }

    const meta = isObject(record.meta) ? record.meta : null
    return meta?.sentFrom === CODEX_DESKTOP_SYNC_SOURCE
}

export function isNativeHapiRunnerSession(metadata: unknown | null | undefined): boolean {
    if (!isObject(metadata)) {
        return false
    }
    if (metadata.mirrorSource === CODEX_DESKTOP_SYNC_SOURCE) {
        return false
    }
    return metadata.startedFromRunner === true || metadata.startedBy === 'runner'
}

export function isCodexDesktopMirrorSession(args: {
    metadata?: unknown | null
    messages?: Array<{
        localId?: string | null
        content: unknown
    }> | null
}): boolean {
    if (isObject(args.metadata) && args.metadata.mirrorSource === CODEX_DESKTOP_SYNC_SOURCE) {
        return true
    }
    if (isNativeHapiRunnerSession(args.metadata)) {
        return false
    }

    for (const message of args.messages ?? []) {
        if (isCodexDesktopSyncMessageEnvelope(message)) {
            return true
        }
    }

    return false
}

export function getExecutionControl(metadata: unknown | null | undefined): ExecutionControl | null {
    if (!isObject(metadata) || !isObject(metadata.executionControl)) {
        return null
    }

    const parsed = ExecutionControlSchema.safeParse(metadata.executionControl)
    return parsed.success ? parsed.data : null
}

export type { RoleWrappedRecord }
