import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { PendingRequest, SessionSummary } from '@/types/api'
import type { SessionAttention } from '@/lib/sessionAttention'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionAttentionIndicator } from './SessionAttentionIndicator'

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
        ...overrides
    }
}

function makeRequest(overrides: Partial<PendingRequest> & { id: string; kind: PendingRequest['kind']; tool: string }): PendingRequest {
    return { since: 0, ...overrides }
}

describe('SessionAttentionIndicator tooltip', () => {
    it('renders permission tooltip body listing each pending tool', () => {
        const summary = makeSummary({
            id: 's1',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['permission'],
            pendingRequests: [
                makeRequest({ id: 'r1', kind: 'permission', tool: 'Bash' }),
                makeRequest({ id: 'r2', kind: 'permission', tool: 'Edit' })
            ]
        })
        const attention: SessionAttention = { kind: 'permission' }

        renderWithI18n(
            <SessionAttentionIndicator
                attention={attention}
                summary={summary}
                label="Permission required"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('Permission required')
        expect(tooltip.textContent).toContain('Approve:')
        expect(tooltip.textContent).toContain('Bash')
        expect(tooltip.textContent).toContain('Edit')
        expect(tooltip.textContent).not.toContain('+1 more')
    })

    it('shows "+N more" when pendingRequestsCount exceeds the rendered slice', () => {
        const summary = makeSummary({
            id: 's1',
            pendingRequestsCount: 7,
            pendingRequestKinds: ['permission'],
            pendingRequests: [
                makeRequest({ id: 'r1', kind: 'permission', tool: 'Bash' }),
                makeRequest({ id: 'r2', kind: 'permission', tool: 'Edit' }),
                makeRequest({ id: 'r3', kind: 'permission', tool: 'Read' }),
                makeRequest({ id: 'r4', kind: 'permission', tool: 'Write' }),
                makeRequest({ id: 'r5', kind: 'permission', tool: 'Glob' })
            ]
        })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'permission' }}
                summary={summary}
                label="Permission required"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('+2 more')
    })

    it('renders only the requested kind even when both kinds are pending', () => {
        const summary = makeSummary({
            id: 's1',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['permission', 'input'],
            pendingRequests: [
                makeRequest({ id: 'r1', kind: 'permission', tool: 'Bash' }),
                makeRequest({ id: 'r2', kind: 'input', tool: 'AskUserQuestion' })
            ]
        })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'input' }}
                summary={summary}
                label="Needs input"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('Needs input')
        expect(tooltip.textContent).toContain('Reply to:')
        expect(tooltip.textContent).toContain('AskUserQuestion')
        expect(tooltip.textContent).not.toContain('Bash')
    })

    it('suppresses the "+N more" hint when both kinds are pending and the slice is capped', () => {
        // 5 mixed requests in the slice + 2 more we don't see. The total count
        // mixes kinds so we cannot honestly report a per-kind overflow.
        const summary = makeSummary({
            id: 's1',
            pendingRequestsCount: 7,
            pendingRequestKinds: ['permission', 'input'],
            pendingRequests: [
                makeRequest({ id: 'r1', kind: 'permission', tool: 'Bash' }),
                makeRequest({ id: 'r2', kind: 'permission', tool: 'Edit' }),
                makeRequest({ id: 'r3', kind: 'permission', tool: 'Read' }),
                makeRequest({ id: 'r4', kind: 'input', tool: 'AskUserQuestion' }),
                makeRequest({ id: 'r5', kind: 'input', tool: 'request_user_input' })
            ]
        })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'permission' }}
                summary={summary}
                label="Permission required"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('Bash')
        expect(tooltip.textContent).toContain('Edit')
        expect(tooltip.textContent).toContain('Read')
        expect(tooltip.textContent).not.toMatch(/\+\d+ more/)
    })

    it('renders background task count', () => {
        const summary = makeSummary({
            id: 's1',
            backgroundTaskCount: 3
        })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'background' }}
                summary={summary}
                label="Background tasks running"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('Background tasks running')
        expect(tooltip.textContent).toContain('3 tasks running')
    })

    it('renders only the title for unread attention (relative time is already on the row)', () => {
        const updatedAt = Date.now() - 5 * 60_000
        const summary = makeSummary({
            id: 's1',
            updatedAt
        })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'unread' }}
                summary={summary}
                label="New activity"
            />
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.textContent).toContain('New activity')
        // The "Nm ago" pill in the session row already shows this; do not duplicate.
        expect(tooltip.textContent).not.toMatch(/Updated /)
    })

    it('exposes aria-label on the dot for screen readers', () => {
        const summary = makeSummary({ id: 's1' })

        renderWithI18n(
            <SessionAttentionIndicator
                attention={{ kind: 'unread' }}
                summary={summary}
                label="New activity"
            />
        )

        expect(screen.getByLabelText('New activity')).toBeTruthy()
    })
})
