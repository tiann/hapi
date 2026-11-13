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
    match: { strategy: 'anchored'; cursorKey?: 'piHistoryLeafEntryId' }
        | { strategy: 'contentPrefix'; compareKey?: (content: unknown) => string | null }
    /** Lifecycle stamped on create. */
    lifecycleOnCreate: 'archived' | 'imported'
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
    match: { strategy: 'anchored' },
    lifecycleOnCreate: 'archived',
    batch: 'continue',
    importLimit: 200,
    localIdPrefix: 'claude:',
    requiredMachineCapability: MACHINE_CAPABILITIES.LocalSessionImport
}

export const CODEX_LOCAL_SESSION_SOURCE: HubLocalSessionSource = {
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