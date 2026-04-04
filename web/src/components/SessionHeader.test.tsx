import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { Session } from '@/types/api'
import { SessionHeader } from './SessionHeader'

function renderSessionHeader(session: Session) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SessionHeader
                    session={session}
                    onBack={() => {}}
                    api={null}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionHeader', () => {
    it('shows session info dialog with cwd and source session id', async () => {
        renderSessionHeader({
            id: 'hapi-session-123',
            namespace: 'default',
            seq: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            active: true,
            activeAt: Date.now(),
            metadata: {
                path: '/tmp/project',
                host: 'machine.local',
                flavor: 'codex',
                name: 'Imported session',
                codexSessionId: 'codex-source-456'
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: Date.now(),
            model: null,
            effort: null
        })

        fireEvent.click(screen.getByTitle('More actions'))
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Session Info' }))

        expect(await screen.findByText('Working directory')).toBeInTheDocument()
        expect(screen.getByText('/tmp/project')).toBeInTheDocument()
        expect(screen.getByText('HAPI session id')).toBeInTheDocument()
        expect(screen.getByText('hapi-session-123')).toBeInTheDocument()
        expect(screen.getByText('Source session id')).toBeInTheDocument()
        expect(screen.getByText('codex-source-456')).toBeInTheDocument()
    })
})
