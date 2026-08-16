import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { NotifySummaryText } from './NotifySummaryText'

const { mockUseSessionSummaryInChat } = vi.hoisted(() => ({
    mockUseSessionSummaryInChat: vi.fn(() => true)
}))

vi.mock('@/hooks/useSessionSummaryInChat', () => ({
    useSessionSummaryInChat: () => mockUseSessionSummaryInChat()
}))

vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MarkdownText: ({ smooth }: { smooth?: boolean }) => (
        <div data-testid="raw-markdown" data-smooth={String(smooth)}>
            raw assistant text
        </div>
    )
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => (
        <div data-testid="visible-markdown">{content}</div>
    )
}))

function renderText(text: string, statusType: 'complete' | 'running' = 'complete') {
    return render(
        <I18nProvider>
            <NotifySummaryText type="text" text={text} status={{ type: statusType }} />
        </I18nProvider>
    )
}

describe('NotifySummaryText', () => {
    beforeEach(() => {
        mockUseSessionSummaryInChat.mockReturnValue(true)
    })

    it('renders the prose and compact summary footer instead of raw JSON', () => {
        renderText('Did the work.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done","action":"Review it"}')

        expect(screen.getByTestId('visible-markdown')).toHaveTextContent('Did the work.')
        expect(screen.getByTestId('notify-summary-footer')).toHaveTextContent('Done')
        expect(screen.getByTestId('notify-summary-footer')).toHaveTextContent('→Review it')
        expect(screen.getByTestId('notify-summary-status')).toHaveAttribute('aria-label', 'Done')
        expect(screen.getByTestId('notify-summary-status')).not.toHaveTextContent('Done')
        expect(screen.getByTestId('notify-summary-status').querySelector('svg')).toBeInTheDocument()
        expect(screen.queryByText(/AGENT_NOTIFY_SUMMARY/)).toBeNull()
    })

    it('strips the footer when chat display is off', () => {
        mockUseSessionSummaryInChat.mockReturnValue(false)
        renderText('Did the work.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}')

        expect(screen.getByTestId('visible-markdown')).toHaveTextContent('Did the work.')
        expect(screen.queryByTestId('notify-summary-footer')).toBeNull()
        expect(screen.queryByText(/AGENT_NOTIFY_SUMMARY/)).toBeNull()
    })

    it('keeps a status label and dot for non-complete summaries', () => {
        renderText('Needs input.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Waiting","status":"needs_review"}')

        expect(screen.getByTestId('notify-summary-status')).toHaveTextContent('Needs review')
        expect(screen.getByTestId('notify-summary-status').querySelector('svg')).toBeNull()
    })

    it('humanizes unknown prototype-named statuses instead of using inherited presentations', () => {
        const view = renderText('Finished.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"constructor"}')

        expect(screen.getByTestId('notify-summary-status')).toHaveTextContent('Constructor')
        expect(screen.getByTestId('notify-summary-status').querySelector('svg')).toBeNull()

        view.unmount()
        renderText('Finished.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"__proto__"}')

        expect(screen.getByTestId('notify-summary-status')).toHaveTextContent('Proto')
        expect(screen.getByTestId('notify-summary-status').querySelector('svg')).toBeNull()
    })

    it('keeps prose glued to the footer in the visible message body', () => {
        renderText('Ownership session pinged.AGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}')

        expect(screen.getByTestId('visible-markdown')).toHaveTextContent('Ownership session pinged.')
        expect(screen.getByTestId('notify-summary-footer')).toHaveTextContent('Done')
        expect(screen.queryByText(/AGENT_NOTIFY_SUMMARY/)).toBeNull()
    })

    it('uses the normal markdown renderer when there is no valid footer', () => {
        renderText('Plain assistant prose.')

        expect(screen.getByTestId('raw-markdown')).toBeInTheDocument()
        expect(screen.queryByTestId('notify-summary-footer')).toBeNull()
    })

    it('hides a recognized footer with no displayable fields instead of raw JSON', () => {
        renderText('Did the work.\n\nAGENT_NOTIFY_SUMMARY {"version":1,"agent":"codex"}')

        expect(screen.getByTestId('visible-markdown')).toHaveTextContent('Did the work.')
        expect(screen.queryByTestId('notify-summary-footer')).toBeNull()
        expect(screen.queryByText(/AGENT_NOTIFY_SUMMARY/)).toBeNull()
    })

    it('keeps a complete-looking footer in markdown while the message is streaming', () => {
        mockUseSessionSummaryInChat.mockReturnValue(true)
        renderText('Still working.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}', 'running')

        expect(screen.getByTestId('raw-markdown')).toBeInTheDocument()
        expect(screen.queryByTestId('notify-summary-footer')).toBeNull()
    })

    it('strips a well-formed footer while streaming when display is off', () => {
        mockUseSessionSummaryInChat.mockReturnValue(false)
        renderText('Still working.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}', 'running')

        expect(screen.getByTestId('visible-markdown')).toHaveTextContent('Still working.')
        expect(screen.queryByText(/AGENT_NOTIFY_SUMMARY/)).toBeNull()
    })

    it('keeps the typewriter for a newly mounted running text part', () => {
        const view = renderText('Already generated.', 'running')

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'true')

        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated with more." status={{ type: 'running' }} />
            </I18nProvider>
        )

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'true')
    })

    it('does not enable smoothing when a completed message is briefly marked running', () => {
        mockUseSessionSummaryInChat.mockReturnValue(false)
        const view = renderText('Already generated.', 'complete')

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'false')

        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated." status={{ type: 'running' }} />
            </I18nProvider>
        )
        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated." status={{ type: 'running' }} />
            </I18nProvider>
        )

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'false')
    })

    it('smooths new text when a completed message becomes running', () => {
        mockUseSessionSummaryInChat.mockReturnValue(false)
        const view = renderText('Already generated.', 'complete')

        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated with new output." status={{ type: 'running' }} />
            </I18nProvider>
        )

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'true')
    })

    it('does not reuse an earlier stream after the part completes', () => {
        mockUseSessionSummaryInChat.mockReturnValue(false)
        const view = renderText('Already generated.', 'running')

        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated with new output." status={{ type: 'running' }} />
            </I18nProvider>
        )
        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'true')

        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated with new output." status={{ type: 'complete' }} />
            </I18nProvider>
        )
        view.rerender(
            <I18nProvider>
                <NotifySummaryText type="text" text="Already generated with new output." status={{ type: 'running' }} />
            </I18nProvider>
        )

        expect(screen.getByTestId('raw-markdown')).toHaveAttribute('data-smooth', 'false')
    })
})
