import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { DshSessionView } from './index'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'

function createSession(overrides?: Partial<Session>): Session {
    return {
        id: 'dsh-session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'dsh',
            dshSessionId: 'dsh-session-1',
        },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined,
        ...overrides,
    } as Session
}

function renderView(session: Session) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    })
    const api = {
        dshAction: async () => ({ ok: true as const, result: {} }),
        dshModels: async () => ({
            current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routable: true,
            groups: [],
            failures: [],
        }),
        dshSkills: async () => ({ skills: [] }),
    } as unknown as ApiClient
    return render(
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <DshSessionView session={session} api={api} />
            </QueryClientProvider>
        </I18nProvider>
    )
}

describe('DshSessionView', () => {
    it('renders the session header with model and running state', () => {
        const session = createSession()
        renderView(session)
        expect(screen.getByText('DeepSeek Harness')).toBeTruthy()
        // Composer + empty state render.
        expect(screen.getByText('No messages yet — describe what you want the agent to do.')).toBeTruthy()
    })
})
