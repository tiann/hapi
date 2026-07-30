import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function renderDetailedBash(command: string, state: 'pending' | 'completed' = 'completed') {
    const completed = state === 'completed'
    const block: ToolCallBlock = {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'tool-1',
            name: 'Bash',
            state,
            input: { command },
            createdAt: 1_000,
            startedAt: completed ? 1_000 : null,
            completedAt: completed ? 1_500 : null,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: completed ? 'ok' : undefined,
        },
        children: [],
    }

    render(
        <I18nProvider>
            <ToolCard
                api={{} as ApiClient}
                sessionId="session-1"
                metadata={null}
                terminalToolDisplayMode="detailed"
                disabled={false}
                onDone={() => {}}
                block={block}
            />
        </I18nProvider>
    )

    return screen.getByText('Input').parentElement?.parentElement
}

describe('ToolCard spacing', () => {
    it('matches the dialog gap when the timing header has a subtitle', () => {
        const inlineBody = renderDetailedBash('echo hello && pwd')

        expect(inlineBody).toHaveClass('mt-1')
        expect(inlineBody).toHaveClass('gap-4')
        expect(inlineBody).not.toHaveClass('mt-3')
        expect(inlineBody).not.toHaveClass('gap-3')
    })

    it('matches the dialog gap when the timing header has no subtitle', () => {
        const inlineBody = renderDetailedBash('pwd')

        expect(inlineBody).toHaveClass('mt-0')
        expect(inlineBody).not.toHaveClass('mt-3')
    })

    it('keeps the original body spacing when pending tools have no timing summary', () => {
        const inlineBody = renderDetailedBash('pwd', 'pending')

        expect(inlineBody).toHaveClass('mt-3')
    })
})

describe('ToolCard detail dialog', () => {
    it('keeps the tool detail title left-aligned on mobile', () => {
        renderDetailedBash('pwd')

        fireEvent.click(screen.getByRole('button', { expanded: false }))

        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading')
        expect(title.parentElement).toHaveClass('text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-2')
    })
})
