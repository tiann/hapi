import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab } from '@/hooks/useEditorState'
import { EditorTerminal } from './EditorTerminal'

const tabs: EditorTab[] = [
    { id: 'file-1', type: 'file', path: '/repo/src/App.tsx', label: 'App.tsx' },
    { id: 'term-1', type: 'terminal', label: 'Terminal: bash', shell: 'bash' },
    { id: 'term-2', type: 'terminal', label: 'Terminal: zsh', shell: 'zsh' }
]

describe('EditorTerminal', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows an empty state when no terminal tabs exist', () => {
        render(
            <EditorTerminal
                tabs={[tabs[0]]}
                activeTabId="file-1"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('No terminal open')).toBeInTheDocument()
    })

    it('renders only terminal tabs and tab actions', () => {
        const onSelectTab = vi.fn()
        const onCloseTab = vi.fn()
        const onOpenTerminal = vi.fn()

        render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onOpenTerminal={onOpenTerminal}
            />
        )

        expect(screen.queryByText('App.tsx')).not.toBeInTheDocument()
        expect(screen.getByText('Terminal: bash')).toBeInTheDocument()
        expect(screen.getAllByText('Terminal: zsh')).toHaveLength(2)
        expect(screen.getByText('Machine terminal placeholder for zsh')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Select terminal Terminal: bash' }))
        expect(onSelectTab).toHaveBeenCalledWith('term-1')

        fireEvent.click(screen.getByRole('button', { name: 'Close terminal Terminal: zsh' }))
        expect(onCloseTab).toHaveBeenCalledWith('term-2')

        fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
        expect(onOpenTerminal).toHaveBeenCalled()
    })
})
