import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionRowSummary } from './SessionRowSummary'

afterEach(() => cleanup())

function renderWithI18n(children: ReactNode) {
    return render(<I18nProvider>{children}</I18nProvider>)
}

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides,
    }
}

describe('SessionRowSummary model-error + attention', () => {
    it('shows model-error and permission attention together', () => {
        const summary = makeSummary({
            id: 's-both',
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: 0 }],
            metadata: {
                lastModelError: {
                    kind: 'model_not_found',
                    transient: false,
                    rawSnippet: 'Unknown model',
                    atTs: 1,
                    priorAssistantClaimsDone: false,
                },
            },
        })

        renderWithI18n(
            <SessionRowSummary
                session={summary}
                showDetailedStatus
                selected={false}
                nestedTooltips={false}
            />
        )

        expect(screen.getByLabelText(/Model error/i)).toBeTruthy()
        expect(screen.getByLabelText('Permission required')).toBeTruthy()
    })
})
