import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolTimingSummary } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

describe('ToolTimingSummary', () => {
    it('renders aligned label/value pairs for completed timing', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={1_700_000_002_500} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.getByText('2.5s')).toBeInTheDocument()
    })

    it('omits finish while timing is still live', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={null} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
    })

    it('supports the compact UI typography used by grouped cards', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={null} durationMs={2_500} typography="group" />
            </I18nProvider>
        )

        const summary = screen.getByText('Started').parentElement?.parentElement
        expect(summary).toHaveClass('text-xs', 'items-baseline')
        expect(summary).not.toHaveClass('items-center', 'font-sans', 'font-normal', 'leading-5')
        expect(summary).not.toHaveClass('font-mono')
    })
})
