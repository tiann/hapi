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
                isCollapsed={false}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(screen.getByText('No terminal open')).toBeInTheDocument()
    })

    it('renders only terminal tabs and tab actions', () => {
        const onSelectTab = vi.fn()
        const onCloseTab = vi.fn()
        const onOpenTerminal = vi.fn()
        const onToggleCollapsed = vi.fn()

        render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={false}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onOpenTerminal={onOpenTerminal}
                onToggleCollapsed={onToggleCollapsed}
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
        expect(onOpenTerminal).toHaveBeenCalledWith()

        fireEvent.click(screen.getByRole('button', { name: 'Collapse terminal' }))
        expect(onToggleCollapsed).toHaveBeenCalledWith()
    })

    it('hides terminal body content when collapsed and exposes expand action', () => {
        render(
            <EditorTerminal
                tabs={tabs}
                activeTabId="term-2"
                isCollapsed={true}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
                onToggleCollapsed={vi.fn()}
            />
        )

        expect(screen.queryByText('Machine terminal placeholder for zsh')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Expand terminal' })).toBeInTheDocument()
    })
})
