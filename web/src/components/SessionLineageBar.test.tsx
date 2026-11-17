import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session, SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionLineageBar } from './SessionLineageBar'

afterEach(() => cleanup())

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        ...overrides
    }
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        namespace: 'default',
        seq: 1,
        createdAt: 100,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        metadata: { path: '/work/proj', host: 'dev' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: [],
        todosUpdatedAt: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        ...overrides
    }
}

describe('SessionLineageBar', () => {
    it('renders nothing when a session has neither parent nor linked children', () => {
        const { container } = render(
            <I18nProvider>
                <SessionLineageBar session={makeSession({ id: 'solo' })} sessions={[]} />
            </I18nProvider>
        )
        expect(container.firstChild).toBeNull()
    })

    it('renders clickable parent and overflowing child session pills sorted by activity', () => {
        const session = makeSession({
            id: 'lead',
            metadata: { path: '/work/proj', host: 'dev', parentSessionId: 'parent-0' }
        })
        const sessions: SessionSummary[] = [
            makeSummary({ id: 'parent-0', active: true, metadata: { path: '/work/proj', name: 'Root Orchestrator' } }),
            makeSummary({ id: 'c1', active: false, updatedAt: 100, metadata: { path: '/work/proj', name: 'Worker 1', parentLink: { parentSessionId: 'lead', kind: 'peer' } } }),
            makeSummary({ id: 'c2', active: false, updatedAt: 200, metadata: { path: '/work/proj', name: 'Worker 2', parentLink: { parentSessionId: 'lead', kind: 'peer' } } }),
            makeSummary({ id: 'c3', active: false, updatedAt: 300, metadata: { path: '/work/proj', name: 'Worker 3', parentLink: { parentSessionId: 'lead', kind: 'peer' } } }),
            makeSummary({ id: 'c4', active: false, updatedAt: 400, metadata: { path: '/work/proj', name: 'Worker 4', parentLink: { parentSessionId: 'lead', kind: 'peer' } } }),
            makeSummary({ id: 'c5', active: true, thinking: true, updatedAt: 50, metadata: { path: '/work/proj', name: 'Running Worker', parentLink: { parentSessionId: 'lead', kind: 'fork' } } })
        ]

        render(
            <I18nProvider>
                <SessionLineageBar session={session} sessions={sessions} />
            </I18nProvider>
        )

        const parentLink = screen.getByRole('link', { name: /Root Orchestrator/ })
        expect(parentLink.getAttribute('href')).toBe('/sessions/parent-0')
        expect(screen.getByRole('link', { name: /Running Worker/ })).toBeInTheDocument()
        expect(screen.getByText('fork')).toBeInTheDocument()
        expect(screen.queryByText('peer')).toBeNull()
        expect(screen.queryByRole('link', { name: /Worker 1/ })).toBeNull()
        expect(screen.queryByRole('link', { name: /Worker 2/ })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: /\+2/ }))
        expect(screen.getByRole('link', { name: /Worker 1/ }).getAttribute('href')).toBe('/sessions/c1')
        expect(screen.getByRole('link', { name: /Worker 2/ }).getAttribute('href')).toBe('/sessions/c2')
    })

    it('preserves conversationBranch notice and uncertain status when branched', () => {
        const session = makeSession({
            id: 'branched',
            metadata: {
                path: '/work/proj',
                host: 'dev',
                conversationBranch: {
                    sourceSessionId: 'src-1',
                    boundary: 'after',
                    mode: 'visible-text',
                    requestFingerprint: 'fp-1',
                    state: 'uncertain',
                    createdAt: 100,
                    messageCount: 3,
                    workspace: 'current'
                }
            }
        })

        render(
            <I18nProvider>
                <SessionLineageBar session={session} sessions={[]} />
            </I18nProvider>
        )

        expect(screen.getByRole('link', { name: /Branched from this conversation/ }).getAttribute('href')).toBe('/sessions/src-1')
        expect(screen.getByRole('status')).toBeInTheDocument()
    })
})
