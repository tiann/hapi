import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { sessionSeedFromSummary } from './sessionSeed'

/** A full (non-slim) summary row — every field materialized. */
function fullRow(): SessionSummary {
    return {
        contentRevision: 7,
        readState: { version: 3, readRevision: 2, manualUnread: false },
        hasConversationContent: true,
        id: 's-full',
        active: true,
        thinking: true,
        activeAt: 1234,
        updatedAt: 2000,
        createdAt: 1000,
        lastUserMessageAt: 1900,
        pinned: true,
        metadata: {
            path: '/work/proj',
            name: 'My session',
            flavor: 'codex',
            machineId: 'mac-1',
            agentSessionId: 'codex-thread-9',
            lifecycleState: 'running'
        },
        metadataVersion: 11,
        agentStateVersion: 22,
        todosUpdatedAt: 33,
        todoProgress: { completed: 1, total: 2 },
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: 'gpt-5',
        modelReasoningEffort: 'high',
        effort: 'medium'
    }
}

/** A view=slim wire row as stored in the sessions list cache: detail-only
 *  fields absent, empty-default fields omitted entirely. */
const slimRow = {
    id: 's-slim',
    updatedAt: 5000,
    createdAt: 4000,
    lastUserMessageAt: 4900,
    active: true,
    metadataVersion: 5,
    agentStateVersion: 6,
    todosUpdatedAt: 7,
    contentRevision: 9,
    metadata: {
        path: '/work/other',
        flavor: 'claude',
        machineId: 'mac-2'
    }
} as unknown as SessionSummary

describe('sessionSeedFromSummary', () => {
    it('carries every field a full summary provides', () => {
        const seed = sessionSeedFromSummary(fullRow())
        expect(seed).toMatchObject({
            id: 's-full',
            active: true,
            thinking: true,
            activeAt: 1234,
            updatedAt: 2000,
            createdAt: 1000,
            pinned: true,
            contentRevision: 7,
            readState: { version: 3, readRevision: 2, manualUnread: false },
            hasConversationContent: true,
            metadataVersion: 11,
            agentStateVersion: 22,
            todosUpdatedAt: 33,
            model: 'gpt-5',
            modelReasoningEffort: 'high',
            effort: 'medium'
        })
    })

    it('restores the flavor-native agent session id from the derived summary field', () => {
        const seed = sessionSeedFromSummary(fullRow())
        expect(seed.metadata).not.toBeNull()
        expect(seed.metadata?.codexSessionId).toBe('codex-thread-9')
        // Summary-only keys must not leak into the Metadata-shaped seed.
        expect((seed.metadata as unknown as Record<string, unknown>).agentSessionId).toBeUndefined()
        expect((seed.metadata as unknown as Record<string, unknown>).conversationHistory).toBeUndefined()
    })

    it('keeps null metadata null', () => {
        const row = { ...fullRow(), id: 's-nullmeta', metadata: null }
        expect(sessionSeedFromSummary(row).metadata).toBeNull()
    })

    it('materializes schema defaults for keys a slim row omits', () => {
        const seed = sessionSeedFromSummary(slimRow)
        expect(seed.active).toBe(true)
        expect(seed.thinking).toBe(false)
        expect(seed.pinned).toBe(false)
        expect(seed.model).toBeNull()
        expect(seed.modelReasoningEffort).toBeNull()
        expect(seed.effort).toBeNull()
        // activeAt is detail-only: 0 is the fallback-friendly default
        // (SessionHeader reads `activeAt || updatedAt`).
        expect(seed.activeAt).toBe(0)
        expect(seed.agentState).toBeNull()
        expect(seed.namespace).toBe('')
        expect(seed.seq).toBe(0)
        expect(seed.backgroundTaskCount).toBe(0)
        expect(seed.todos).toBeUndefined()
        expect(seed.backgroundTasks).toBeUndefined()
        expect(seed.serviceTier).toBeNull()
        expect(seed.createdAt).toBe(4000)
        // Version watermarks survive — the SSE patch gates compare them.
        expect(seed.metadataVersion).toBe(5)
        expect(seed.agentStateVersion).toBe(6)
        expect(seed.todosUpdatedAt).toBe(7)
        expect(seed.contentRevision).toBe(9)
    })

    it('maps the claude fallback flavor onto claudeSessionId', () => {
        const row = {
            ...slimRow,
            metadata: { path: '/w', flavor: null, agentSessionId: 'claude-1' }
        } as unknown as SessionSummary
        const seed = sessionSeedFromSummary(row)
        // Unknown/absent flavor resolves to the claude slot, mirroring
        // resolveAgentSessionIdFromMetadata.
        expect(seed.metadata?.claudeSessionId).toBe('claude-1')
    })

    it('maps a zcode row onto zcodeSessionId (reader-aligned)', () => {
        const row = {
            ...slimRow,
            metadata: { path: '/w', flavor: 'zcode', agentSessionId: 'z-1' }
        } as unknown as SessionSummary
        const seed = sessionSeedFromSummary(row)
        expect(seed.metadata?.zcodeSessionId).toBe('z-1')
        expect(seed.metadata?.path).toBe('/w')
    })
})
