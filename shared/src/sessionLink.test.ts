import { describe, expect, it } from 'bun:test'
import { extractExplicitParentSessionIdFromRemit } from './peerParentStamp'
import { resolveSessionParentLink } from './sessionLink'
import { toSessionSummary, toSessionSummaryMetadata } from './sessionSummary'
import type { Session } from './schemas'

describe('resolveSessionParentLink', () => {
    it('resolves peer, branch, and fork links in precedence order', () => {
        expect(resolveSessionParentLink({
            parentSessionId: 'parent-peer',
            conversationBranch: { sourceSessionId: 'parent-branch' },
            forkedFrom: 'parent-fork'
        })).toEqual({
            parentSessionId: 'parent-peer',
            kind: 'peer'
        })

        expect(resolveSessionParentLink({
            conversationBranch: { sourceSessionId: 'parent-branch' },
            forkedFrom: 'parent-fork'
        })).toEqual({
            parentSessionId: 'parent-branch',
            kind: 'branch'
        })

        expect(resolveSessionParentLink({
            forkedFrom: 'parent-fork'
        })).toEqual({
            parentSessionId: 'parent-fork',
            kind: 'fork'
        })
    })

    it('rejects empty ids and self-links', () => {
        expect(resolveSessionParentLink(null)).toBeNull()
        expect(resolveSessionParentLink({ parentSessionId: '   ' })).toBeNull()
        expect(resolveSessionParentLink({ parentSessionId: 'self-id' }, 'self-id')).toBeNull()
        expect(resolveSessionParentLink({ forkedFrom: 'self-id' }, 'self-id')).toBeNull()
    })
})

describe('toSessionSummary parentLink projection', () => {
    it('projects parentLink onto summary metadata while rejecting self-links', () => {
        const meta = toSessionSummaryMetadata({
            path: '/repo',
            host: 'dev',
            parentSessionId: 'parent-1'
        }, 'child-1')
        expect(meta?.parentLink).toEqual({
            parentSessionId: 'parent-1',
            kind: 'peer'
        })

        const session: Session = {
            id: 'child-2',
            seq: 1,
            createdAt: 100,
            updatedAt: 200,
            active: true,
            activeAt: 200,
            metadata: {
                path: '/repo',
                host: 'dev',
                forkedFrom: 'parent-2'
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            todos: [],
            todosUpdatedAt: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            effort: null,
            permissionMode: 'default'
        }
        const summary = toSessionSummary(session)
        expect(summary.metadata?.parentLink).toEqual({
            parentSessionId: 'parent-2',
            kind: 'fork'
        })
    })
})

describe('extractExplicitParentSessionIdFromRemit', () => {
    it('extracts parent id only when an explicit ## Parent heading is present', () => {
        const stamped = [
            '## Parent',
            '- Orchestrator chip (mandatory): [Main](/sessions/11111111-1111-4111-8111-111111111111)',
            '',
            'Implement task A'
        ].join('\n')
        expect(extractExplicitParentSessionIdFromRemit(stamped)).toBe('11111111-1111-4111-8111-111111111111')

        const casualCitation = 'See session "Other" (/sessions/22222222-2222-4222-8222-222222222222) for context'
        expect(extractExplicitParentSessionIdFromRemit(casualCitation)).toBeNull()
    })
})
