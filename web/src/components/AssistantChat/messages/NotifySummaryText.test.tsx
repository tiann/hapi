import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { NotifySummaryText } from './NotifySummaryText'

vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MarkdownText: () => <div data-testid="raw-markdown">raw assistant text</div>
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

    it('keeps a status label and dot for non-complete summaries', () => {
        renderText('Needs input.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Waiting","status":"needs_review"}')

        expect(screen.getByTestId('notify-summary-status')).toHaveTextContent('Needs review')
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

    it('keeps a complete-looking footer in markdown while the message is streaming', () => {
        renderText('Still working.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}', 'running')

        expect(screen.getByTestId('raw-markdown')).toBeInTheDocument()
        expect(screen.queryByTestId('notify-summary-footer')).toBeNull()
    })
})
