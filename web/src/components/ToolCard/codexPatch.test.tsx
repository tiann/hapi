import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

const diff = '@@ -1 +1 @@\n-const retries = 2;\n+const retries = 3;\n'
const path = '/workspace/client/retry.ts'

function renderPatch(changes: unknown) {
    const block: ToolCallBlock = {
        kind: 'tool-call', id: 'patch', localId: null, createdAt: 1, children: [],
        tool: {
            name: 'CodexPatch', id: 'patch', input: { changes }, state: 'completed',
            createdAt: 1, startedAt: 1, completedAt: 2, execStartedAt: null, execCompletedAt: null, description: null,
        },
    }
    return render(
        <I18nProvider><ToolCard api={{} as ApiClient} sessionId="session" metadata={null}
            terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} /></I18nProvider>
    )
}

describe('CodexPatch', () => {
    it.each([
        { [path]: { type: 'update', unified_diff: diff } },
        [{ path, kind: { type: 'update', move_path: null }, diff }],
    ])('shows one attributed hunk inline and in details', (changes) => {
        renderPatch(changes)
        const check = (view: Pick<typeof screen, 'getByText'>) => {
            const file = within(view.getByText(path).parentElement!)
            expect(file.getByText('-const retries = 2;').className).toContain('--app-diff-removed-bg')
            expect(file.getByText('+const retries = 3;').className).toContain('--app-diff-added-bg')
        }
        check(screen)
        fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }))
        check(within(screen.getByRole('dialog')))
    })

    it('keeps files with the same basename separate and leaves opaque changes as paths', () => {
        renderPatch({
            'a/index.ts': { type: 'update', unified_diff: diff },
            'b/index.ts': { type: 'update', unified_diff: '@@ -7 +7 @@\n--- marker\n+++ marker' },
            'c/index.ts': { kind: { type: 'add' }, diff: 'literal content' },
        })
        const other = within(screen.getByText('b/index.ts').parentElement!)
        expect(other.queryByText('-const retries = 2;')).toBeNull()
        expect(other.getByText('--- marker').className).toContain('--app-diff-removed-bg')
        expect(other.getByText('+++ marker').className).toContain('--app-diff-added-bg')
        expect(screen.getByText('c/index.ts').parentElement!.textContent).toBe('c/index.ts')
    })

    it('opens path-only details when no diff was supplied', () => {
        renderPatch({ [path]: { type: 'update' } })
        fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(path)).toBeInTheDocument()
        expect(dialog.querySelector('pre')).toBeNull()
    })
})
