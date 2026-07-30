import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

const block: ToolCallBlock = {
    kind: 'tool-call', id: 'codex-diff-1', localId: null, createdAt: 1_000,
    tool: {
        id: 'codex-diff-1', name: 'CodexDiff', state: 'completed',
        input: { unified_diff: 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after' },
        createdAt: 1_000, startedAt: 1_000, completedAt: 1_100, execStartedAt: null, execCompletedAt: null, description: null,
    }, children: [],
}

describe('ToolCard CodexDiff inline interactions', () => {
    it('lets a non-minimal CodexDiff own its preview and wrap controls', () => {
        const { container } = render(
            <I18nProvider><ToolCard api={{} as ApiClient} sessionId="session-1" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} /></I18nProvider>
        )

        expect(container.querySelectorAll('[role="button"] button')).toHaveLength(0)
        const wrapToggle = container.querySelector('[data-hapi-code-wrap-toggle="true"]')!
        fireEvent.click(wrapToggle)
        expect(screen.queryByRole('dialog')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Open diff preview' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
})
