import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard, ToolTimingSummary } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

describe('ToolTimingSummary', () => {
    it('renders only the duration once the tool completes', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={1_700_000_002_500} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('2.5s')).toBeInTheDocument()
        expect(screen.queryByText('Started')).not.toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
        expect(screen.queryByText('Duration')).not.toBeInTheDocument()
    })

    it('keeps the wall-clock times reachable through the title tooltip', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={1_700_000_002_500} durationMs={2_500} />
            </I18nProvider>
        )

        const duration = screen.getByTitle(/Started/)
        expect(duration.getAttribute('title')).toContain('Finished')
        expect(duration.getAttribute('title')).toContain('Duration')
    })

    it('renders a bare live duration while running, without a finish time', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={null} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('2.5s')).toBeInTheDocument()
        expect(screen.queryByText('Started')).not.toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
        const duration = screen.getByTitle(/Started/)
        expect(duration.getAttribute('title')).not.toContain('Finished')
        expect(duration.getAttribute('title')).toContain('Duration')
    })

    it('renders nothing without a duration (clock skew or pending state)', () => {
        const { container } = render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={1_700_000_002_500} durationMs={null} />
            </I18nProvider>
        )

        expect(container.textContent).toBe('')
    })
})

describe('ToolCard collapsed header timing placement', () => {
    function makeBlock(): ToolCallBlock {
        return {
            kind: 'tool-call',
            id: 'tool-1',
            localId: null,
            createdAt: 1_000,
            children: [],
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'completed',
                input: { command: 'bun test' },
                createdAt: 1_000,
                startedAt: 1_000,
                completedAt: 3_500,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                result: 'ok'
            }
        }
    }

    it('sits in the status row next to the icons instead of taking a header row', () => {
        render(
            <I18nProvider>
                <ToolCard
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={null}
                    terminalToolDisplayMode="compact"
                    disabled={false}
                    onDone={() => {}}
                    block={makeBlock()}
                />
            </I18nProvider>
        )

        const duration = screen.getByText('2.5s')
        expect(duration.parentElement).toHaveClass('items-center')
        expect(duration.parentElement).toHaveClass('shrink-0')
        expect(duration.parentElement!.querySelector('svg')).not.toBeNull()
    })
})