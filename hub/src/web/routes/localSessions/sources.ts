import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type {
    OpencodeLocalSessionSummary,
    OpencodeLocalSessionWithMessages,
    PiLocalSessionSummary,
    PiLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import {
    codexToTranscript,
    codexToTranscriptSummary,
    opencodeToTranscript,
    opencodeToTranscriptSummary,
    piToTranscript,
    piToTranscriptSummary
} from '@hapi/protocol/localTranscript'
import type {
    CodexLocalSessionSummary,
    CodexLocalSessionWithMessages,
    LocalSessionFlavor,
    LocalTranscript,
    LocalTranscriptSummary
} from '@hapi/protocol/localTranscript'
import type { MachineCapability } from '@hapi/protocol/runnerCapabilities'
import type { SyncEngine } from '../../../sync/syncEngine'
import type { StoredMessage } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'
import { normalizeComparableText, stableSerializeContent } from './compare'

/**
 * Declarative hub-side source descriptors. Sources only describe
 * HOW to find and match their transcripts; the generic importer owns
 * persistence, lifecycle and launch config.
 */

export type LocalSessionNativeIdKey =
    | 'piSessionId'
    | 'opencodeSessionId'
    | 'claudeSessionId'
    | 'claudeSessionIdHistory'
    | 'agySessionId'
    | 'codexSessionId'
    | 'codexSourceSessionId'

export type HubLocalSessionSource = {
    flavor: LocalSessionFlavor
    displayName: string
    /** REST route base under /api (e.g. 'pi' -> /api/pi/sessions). */
    routeBase: string
    /** First key is primary; the rest are aliases matched on lookup. */
    nativeIdKeys: LocalSessionNativeIdKey[]
    /** How the target HAPI session and the delta are found. */
    match: {
        strategy: 'anchored'
        cursorKey?: 'piHistoryLeafEntryId'
        /** Maps stored and transcript content to the fields that must stay equal. */
        canonicalContent?: (content: unknown) => unknown
        liveCompareKey?: (content: unknown, callIds?: Map<string, number>) => string | null
        liveUserBatchMatches?: (batch: StoredMessage[], nativeContent: unknown) => boolean
    }
        | { strategy: 'contentPrefix'; compareKey?: (content: unknown) => string | null }
    /** Lifecycle stamped on create. */
    lifecycleOnCreate: 'archived' | 'imported'
    /** When true, refuse importing without a validated workspace path (never fall back to dirname(file)). */
    requireWorkingDirectory?: boolean
    /** Multi-import loop policy. */
    batch: 'continue' | 'stopOnFirstError'
    /** Flavor-only import progress metadata key (Pi). */
    importStateKey?: 'piImportState'
    /**
     * Stored localId prefix identifying this flavor's imported rows. Defaults
     * to `${flavor}:${nativeId}:`; Claude omits the native id because resumed
     * sessions rotate it while message uuids stay stable.
     */
    localIdPrefix?: string
    /** Per-request import cap enforced by the route (400 above it). */
    importLimit?: number
    /**
     * Fallback for runners that do not advertise `local-session-import`:
     * fetch via the flavor's legacy RPC and convert raw rows to transcripts.
     * `resultIdKey` stays the legacy response field name for result items.
     */
    legacy?: {
        resultIdKey: string
        fetch(ctx: {
            engine: SyncEngine
            machineId: string
            cwd: string | null
            sessionIds: string[] | null
        }): Promise<{ success: true; sessions: unknown[] } | { success: false; error: string }>
        toTranscript(raw: unknown): LocalTranscriptSummary | LocalTranscript
    }
    requiredMachineCapability?: MachineCapability
    /** Codex request flag yolo -> metadata.preferredPermissionMode. */
    requestMetadata?: (body: Record<string, unknown>) => Record<string, unknown>
    /** Optional hub-owned timestamp used to label imported sessions. */
    importTimestampKey?: 'codexImportedAt' | 'agyImportedAt'
}

/** True when the machine advertises the source's required capability. */
export function machineSupportsLocalSessionImport(source: HubLocalSessionSource, machine: {
    metadata?: { capabilities?: readonly string[] | null } | null
} | null | undefined): boolean {
    const capability = source.requiredMachineCapability
    if (!capability) return true
    return machine?.metadata?.capabilities?.includes(capability) === true
}

/**
 * Codex compare key: agent payload `id` fields are ignored so
 * re-converted transcripts compare equal against stored rows; user text is
 * trailing-whitespace insensitive. Stored rows are truncated at ingest
 * (contentCodec) while transcripts arrive in full; truncation is idempotent,
 * so applying it here keeps both sides canonical. Duplicate handling
 * happens in the matcher, not here.
 */
export function codexCompareKey(content: unknown): string | null {
    const canonical = truncateOversizedMessageContent(content)
    const record = canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical)
        ? canonical as Record<string, unknown>
        : null
    if (!record) return null
    if (record.role === 'user') {
        const body = record.content !== null && typeof record.content === 'object' && !Array.isArray(record.content)
            ? record.content as Record<string, unknown>
            : null
        if (body?.type !== 'text' || typeof body.text !== 'string') return null
        return stableSerializeContent({ role: 'user', text: normalizeComparableText(body.text) })
    }
    if (record.role === 'agent') {
        const body = record.content !== null && typeof record.content === 'object' && !Array.isArray(record.content)
            ? record.content as Record<string, unknown>
            : null
        if (!body || body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
        const data = body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data)
            ? { ...(body.data as Record<string, unknown>) }
            : body.data
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            delete (data as Record<string, unknown>).id
        }
        return stableSerializeContent({ role: 'agent', data })
    }
    return null
}

/**
 * Fields Claude Code rewrites when it copies earlier entries into a resumed
 * transcript (same uuid, new session file) or that describe the process that
 * wrote the entry rather than the conversation.
 */
const CLAUDE_REPLAY_METADATA_KEYS = ['sessionId', 'timestamp', 'cwd', 'gitBranch', 'version'] as const

/**
 * Claude compare form: a raw transcript entry kept as agent output is
 * compared without its replay metadata, so a resumed transcript still lines
 * up with the imported rows; uuid, type and message content stay compared.
 */
export function claudeCanonicalContent(content: unknown): unknown {
    const record = content !== null && typeof content === 'object' && !Array.isArray(content)
        ? content as Record<string, unknown>
        : null
    const body = record?.content !== null && typeof record?.content === 'object' && !Array.isArray(record?.content)
        ? record.content as Record<string, unknown>
        : null
    const data = body?.data !== null && typeof body?.data === 'object' && !Array.isArray(body?.data)
        ? body.data as Record<string, unknown>
        : null
    if (record?.role !== 'agent' || body?.type !== 'output' || !data) return content
    const entry = { ...data }
    for (const key of CLAUDE_REPLAY_METADATA_KEYS) delete entry[key]
    return { ...record, content: { ...body, data: entry } }
}

function isWithMessages(raw: unknown): raw is PiLocalSessionWithMessages | OpencodeLocalSessionWithMessages | CodexLocalSessionWithMessages {
    return raw !== null && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)
}

export const PI_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
    flavor: 'pi',
    displayName: 'Pi',
    routeBase: 'pi',
    nativeIdKeys: ['piSessionId'],
    match: { strategy: 'anchored', cursorKey: 'piHistoryLeafEntryId' },
    lifecycleOnCreate: 'archived',
    batch: 'continue',
    importStateKey: 'piImportState',
    importLimit: 200,
    requiredMachineCapability: MACHINE_CAPABILITIES.LocalSessionImport,
    legacy: {
        resultIdKey: 'piSessionId',
        async fetch({ engine, machineId, cwd, sessionIds }) {
            const result = await engine.listPiSessionsForMachine(machineId, cwd, sessionIds ?? undefined)
            if (!result.success) return { success: false, error: result.error }
            return { success: true, sessions: result.sessions }
        },
        toTranscript: (raw) => isWithMessages(raw)
            ? piToTranscript(raw as PiLocalSessionWithMessages)
            : piToTranscriptSummary(raw as PiLocalSessionSummary)
    }
}

export const OPENCODE_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
    flavor: 'opencode',
    displayName: 'OpenCode',
    routeBase: 'opencode',
    nativeIdKeys: ['opencodeSessionId'],
    match: { strategy: 'anchored' },
    lifecycleOnCreate: 'archived',
    batch: 'continue',
    importLimit: 200,
    requiredMachineCapability: MACHINE_CAPABILITIES.LocalSessionImport,
    legacy: {
        resultIdKey: 'opencodeSessionId',
        async fetch({ engine, machineId, cwd, sessionIds }) {
            const result = await engine.listOpencodeSessionsForMachine(machineId, cwd, sessionIds ?? undefined)
            if (!result.success) return { success: false, error: result.error }
            return { success: true, sessions: result.sessions }
        },
        toTranscript: (raw) => isWithMessages(raw)
            ? opencodeToTranscript(raw as OpencodeLocalSessionWithMessages)
            : opencodeToTranscriptSummary(raw as OpencodeLocalSessionSummary)
    }
}

export const CLAUDE_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
    flavor: 'claude',
    displayName: 'Claude',
    routeBase: 'claude',
    nativeIdKeys: ['claudeSessionId', 'claudeSessionIdHistory'],
    match: { strategy: 'anchored', canonicalContent: claudeCanonicalContent },
    lifecycleOnCreate: 'archived',
    batch: 'continue',
    importLimit: 200,
    localIdPrefix: 'claude:',
    requiredMachineCapability: MACHINE_CAPABILITIES.LocalSessionImport
}

// Delivery metadata differs between native and live messages. Keep the complete
// payload, including attachments, tool identities, results and exit codes.
function normalizeAgyComparableToolOutput(output: unknown): unknown {
    if (typeof output === 'string') return normalizeComparableText(output)
    if (!output || typeof output !== 'object' || Array.isArray(output)) return output
    const record = output as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === 'output' && typeof record.output === 'string') {
        return normalizeComparableText(record.output)
    }
    if (typeof record.stdout === 'string') {
        return { ...record, stdout: normalizeComparableText(record.stdout) }
    }
    return output
}

function agyLiveCompareKey(content: unknown, callIds?: Map<string, number>): string | null {
    if (!content || typeof content !== 'object' || !('role' in content) || !('content' in content)) {
        return stableSerializeContent(content)
    }
    const record = content as { role?: unknown; content?: unknown }
    const body = record.content && typeof record.content === 'object' && !Array.isArray(record.content)
        ? record.content as Record<string, unknown>
        : null
    if (record.role === 'user') {
        if (body?.type === 'text' && typeof body.text === 'string') {
            return stableSerializeContent({
                role: 'user',
                content: { ...body, text: normalizeComparableText(body.text) }
            })
        }
        return stableSerializeContent({ role: 'user', content: record.content })
    }
    if (record.role !== 'agent' || !body) {
        return stableSerializeContent({ role: record.role, content: record.content })
    }
    if (body.type === 'event') return null
    if (body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) {
        return stableSerializeContent({ role: 'agent', content: record.content })
    }
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : null
    if (!data) return stableSerializeContent({ role: 'agent', content: record.content })
    if (
        data.type === 'round-summary'
        || data.type === 'token_count'
        || data.type === 'error'
        || data.live === true
        || data.streamSnapshot === true
    ) {
        return null
    }
    if (data.type === 'reasoning' || data.type === 'message') {
        return stableSerializeContent({
            role: 'agent',
            type: data.type,
            message: typeof data.message === 'string' ? normalizeComparableText(data.message) : data.message
        })
    }
    if (data.type === 'tool-call') {
        const callId = typeof data.callId === 'string' ? data.callId : ''
        let callOrdinal = callIds?.get(callId)
        if (callOrdinal === undefined) {
            callOrdinal = callIds ? callIds.size : 0
            if (callId) callIds?.set(callId, callOrdinal)
        }
        return stableSerializeContent({
            role: 'agent',
            type: 'tool-call',
            callOrdinal,
            name: data.name,
            input: data.input ?? null
        })
    }
    if (data.type === 'tool-call-result') {
        const callId = typeof data.callId === 'string' ? data.callId : ''
        const callOrdinal = callIds?.get(callId) ?? -1
        return stableSerializeContent({
            role: 'agent',
            type: 'tool-call-result',
            callOrdinal,
            output: normalizeAgyComparableToolOutput(data.output),
            is_error: Boolean(data.is_error)
        })
    }
    const rest = { ...data }
    delete rest.id
    return stableSerializeContent({ role: 'agent', data: rest })
}

const AGY_INLINE_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
])

function isInlineImageAttachment(attachment: { mimeType?: unknown }): boolean {
    if (typeof attachment.mimeType !== 'string') return false
    return AGY_INLINE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase().trim())
}

function formatAgyUserPromptText(text: string, paths: string[]): string {
    if (paths.length === 0) return text
    const header = paths.map((path) => `@${path}`).join(' ')
    return text ? `${header}\n\n${text}` : header
}

function agyUserRowCandidateTexts(stored: StoredMessage): string[] | null {
    const content = stored.content
    if (!content || typeof content !== 'object' || !('role' in content) || !('content' in content)) {
        return null
    }
    const record = content as { role?: unknown; content?: unknown }
    if (record.role !== 'user') return null
    const body = record.content && typeof record.content === 'object' && !Array.isArray(record.content)
        ? record.content as Record<string, unknown>
        : null
    if (body?.type !== 'text' || typeof body.text !== 'string') {
        return null
    }
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
    const validAttachments = rawAttachments.filter(
        (item): item is { path: string; mimeType?: unknown } =>
            item !== null
            && typeof item === 'object'
            && typeof (item as { path?: unknown }).path === 'string'
            && (item as { path: string }).path.trim().length > 0
    )
    if (validAttachments.length === 0) {
        return [body.text]
    }
    const allPaths = validAttachments.map((item) => item.path)
    const nonImagePaths = validAttachments
        .filter((item) => !isInlineImageAttachment(item))
        .map((item) => item.path)
    const hasInlineImage = nonImagePaths.length < allPaths.length
    const withAllAttachments = formatAgyUserPromptText(body.text, allPaths)
    if (!hasInlineImage) {
        return [withAllAttachments]
    }
    const withInlineStripped = formatAgyUserPromptText(body.text, nonImagePaths)
    return withInlineStripped === withAllAttachments
        ? [withAllAttachments]
        : [withInlineStripped, withAllAttachments]
}

/**
 * Matches a delivered batch of HAPI user messages sharing one `invokedAt`
 * against a native Antigravity `USER_INPUT` message joined by `\n`, formatting
 * non-image attachments as `@path` while accepting either inline-stripped or
 * `@path`-retained forms for inline-capable image attachments.
 */
export function agyLiveUserBatchMatches(batch: StoredMessage[], nativeContent: unknown): boolean {
    if (batch.length === 0) return false
    if (!nativeContent || typeof nativeContent !== 'object' || !('role' in nativeContent) || !('content' in nativeContent)) {
        return batch.length === 1 && agyLiveCompareKey(batch[0]!.content) === agyLiveCompareKey(nativeContent)
    }
    const nativeRecord = nativeContent as { role?: unknown; content?: unknown }
    const nativeBody = nativeRecord.content && typeof nativeRecord.content === 'object' && !Array.isArray(nativeRecord.content)
        ? nativeRecord.content as Record<string, unknown>
        : null
    if (nativeRecord.role !== 'user' || nativeBody?.type !== 'text' || typeof nativeBody.text !== 'string') {
        return batch.length === 1 && agyLiveCompareKey(batch[0]!.content) === agyLiveCompareKey(nativeContent)
    }

    let candidates: string[] = ['']
    for (const [index, row] of batch.entries()) {
        const rowCandidates = agyUserRowCandidateTexts(row)
        if (!rowCandidates) {
            return batch.length === 1 && agyLiveCompareKey(row.content) === agyLiveCompareKey(nativeContent)
        }
        const next: string[] = []
        const seen = new Set<string>()
        for (const prefix of candidates) {
            for (const part of rowCandidates) {
                const joined = index === 0 ? part : `${prefix}\n${part}`
                if (seen.has(joined)) continue
                seen.add(joined)
                next.push(joined)
            }
        }
        candidates = next
    }
    const targetText = normalizeComparableText(nativeBody.text)
    return candidates.some((candidate) => normalizeComparableText(candidate) === targetText)
}

export const AGY_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
    flavor: 'agy',
    displayName: 'Antigravity',
    importTimestampKey: 'agyImportedAt',
    routeBase: 'agy',
    nativeIdKeys: ['agySessionId'],
    match: {
        strategy: 'anchored',
        liveCompareKey: agyLiveCompareKey,
        liveUserBatchMatches: agyLiveUserBatchMatches
    },
    lifecycleOnCreate: 'archived',
    requireWorkingDirectory: true,
    batch: 'continue',
    importLimit: 200,
    requiredMachineCapability: MACHINE_CAPABILITIES.AgyImportedResume
}

export const CODEX_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
    importTimestampKey: 'codexImportedAt',
    flavor: 'codex',
    displayName: 'Codex',
    routeBase: 'codex',
    nativeIdKeys: ['codexSessionId', 'codexSourceSessionId'],
    match: { strategy: 'contentPrefix', compareKey: codexCompareKey },
    lifecycleOnCreate: 'imported',
    batch: 'stopOnFirstError',
    importLimit: 200,
    requiredMachineCapability: MACHINE_CAPABILITIES.LocalSessionImport,
    requestMetadata: (body) => (body.yolo === true ? { preferredPermissionMode: 'yolo' } : {}),
    legacy: {
        resultIdKey: 'codexSessionId',
        async fetch({ engine, machineId, cwd, sessionIds }) {
            const result = await engine.listCodexSessionsForMachine(machineId, cwd, sessionIds ?? undefined)
            if (!result.success) return { success: false, error: result.error }
            return { success: true, sessions: result.sessions }
        },
        toTranscript: (raw) => isWithMessages(raw)
            ? codexToTranscript(raw as CodexLocalSessionWithMessages)
            : codexToTranscriptSummary(raw as CodexLocalSessionSummary)
    }
}
