import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

const block: ToolCallBlock = {
    kind: 'tool-call', id: 'bash-1', localId: null, createdAt: 1_000,
    tool: {
        id: 'bash-1', name: 'Bash', state: 'completed', input: { command: 'echo preview' },
        createdAt: 1_000, startedAt: 1_000, completedAt: 1_100, execStartedAt: null, execCompletedAt: null, description: null,
    }, children: [],
}

describe('ToolCard inline detail focus', () => {
    it('restores focus to both the header trigger and an inline preview invoker', async () => {
        const { container } = render(
            <I18nProvider><ToolCard api={{} as ApiClient} sessionId="session-1" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} /></I18nProvider>
        )

        const headerTrigger = container.querySelector('button')!
        fireEvent.click(headerTrigger)
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(headerTrigger).toHaveFocus())

        const inlinePreview = container.querySelector('[role="button"]') as HTMLElement
        fireEvent.click(inlinePreview)
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(inlinePreview).toHaveFocus())
    })
})
