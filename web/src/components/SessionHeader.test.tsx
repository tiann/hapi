import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionHeader } from './SessionHeader'

afterEach(() => cleanup())

describe('SessionHeader', () => {
    it('shows an inherited catalog-default Fast tier', () => {
        const session: Session = {
            id: 'session-1',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            metadata: { flavor: 'codex', path: '/repo', host: 'machine' },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            modelReasoningEffort: null,
            effort: null,
            serviceTier: null
        }

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={session}
                            serviceTier="priority"
                            onBack={vi.fn()}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        expect(screen.getByText('fast')).toBeInTheDocument()
    })
})
