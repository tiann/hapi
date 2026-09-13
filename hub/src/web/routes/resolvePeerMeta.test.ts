import { describe, expect, it } from 'bun:test'
import type { SyncEngine } from '../../sync/syncEngine'
import { resolvePeerMetaFromSourceSession } from './messages'

const sourceId = '2e12cfee-aaaa-bbbb-cccc-dddddddddddd'

function engineFor(metadata: Record<string, unknown>): SyncEngine {
    return {
        resolveSessionAccess: (sessionId: string, _namespace: string) => {
            if (sessionId !== sourceId) {
                return { ok: false as const, reason: 'not-found' as const }
            }
            return {
                ok: true as const,
                sessionId: sourceId,
                session: { id: sourceId, active: true, metadata }
            }
        }
    } as unknown as SyncEngine
}

describe('resolvePeerMetaFromSourceSession', () => {
    it('prefers metadata.name', () => {
        const peer = resolvePeerMetaFromSourceSession(
            engineFor({ name: 'Local Testing' }),
            'default',
            sourceId
        )
        expect(peer).toEqual({
            sourceSessionId: sourceId,
            sourceName: 'Local Testing'
        })
    })

    it('falls back to summary text when name is unset', () => {
        const peer = resolvePeerMetaFromSourceSession(
            engineFor({ summary: { text: 'Jellybot Marketing Pages' } }),
            'default',
            sourceId
        )
        expect(peer).toEqual({
            sourceSessionId: sourceId,
            sourceName: 'Jellybot Marketing Pages'
        })
    })

    it('falls back to Windows path basename when name and summary are unset', () => {
        const peer = resolvePeerMetaFromSourceSession(
            engineFor({ path: 'H:\\home\\heavygee\\coding\\teemo-agent' }),
            'default',
            sourceId
        )
        expect(peer).toEqual({
            sourceSessionId: sourceId,
            sourceName: 'teemo-agent'
        })
    })

    it('returns undefined when the source session cannot be resolved', () => {
        const peer = resolvePeerMetaFromSourceSession(
            engineFor({ name: 'orphan' }),
            'default',
            'missing-id'
        )
        expect(peer).toBeUndefined()
    })
})
