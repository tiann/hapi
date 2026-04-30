import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorContextMenu } from './EditorContextMenu'

describe('EditorContextMenu', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders nothing without a file path or position', () => {
        const { container, rerender } = render(
            <EditorContextMenu
                filePath={null}
                position={{ x: 10, y: 20 }}
                onOpen={vi.fn()}
                onAddToChat={vi.fn()}
                onCopyPath={vi.fn()}
                onClose={vi.fn()}
            />
        )
        expect(container).toBeEmptyDOMElement()

        rerender(
            <EditorContextMenu
                filePath="/repo/file.ts"
                position={null}
                onOpen={vi.fn()}
                onAddToChat={vi.fn()}
                onCopyPath={vi.fn()}
                onClose={vi.fn()}
            />
        )
        expect(container).toBeEmptyDOMElement()
    })

    it('renders actions at the provided coordinates', () => {
        render(
            <EditorContextMenu
                filePath="/repo/src/App.tsx"
                position={{ x: 12, y: 34 }}
                onOpen={vi.fn()}
                onAddToChat={vi.fn()}
                onCopyPath={vi.fn()}
                onClose={vi.fn()}
            />
        )

        const menu = screen.getByRole('menu')
        expect(menu).toHaveStyle({ left: '12px', top: '34px' })
        expect(screen.getByRole('menuitem', { name: 'Open in Editor' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Add to Chat' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeInTheDocument()
    })

    it('runs open and add-to-chat actions then closes', () => {
        const onOpen = vi.fn()
        const onAddToChat = vi.fn()
        const onClose = vi.fn()

        render(
            <EditorContextMenu
                filePath="/repo/src/App.tsx"
                position={{ x: 12, y: 34 }}
                onOpen={onOpen}
                onAddToChat={onAddToChat}
                onCopyPath={vi.fn()}
                onClose={onClose}
            />
        )

        fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Editor' }))
        expect(onOpen).toHaveBeenCalledWith('/repo/src/App.tsx')
        expect(onClose).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Chat' }))
        expect(onAddToChat).toHaveBeenCalledWith('/repo/src/App.tsx')
        expect(onClose).toHaveBeenCalledTimes(2)
    })

    it('awaits copy path action before closing', async () => {
        let resolveCopy!: () => void
        const onCopyPath = vi.fn(() => new Promise<void>((resolve) => {
            resolveCopy = resolve
        }))
        const onClose = vi.fn()

        render(
            <EditorContextMenu
                filePath="/repo/src/App.tsx"
                position={{ x: 12, y: 34 }}
                onOpen={vi.fn()}
                onAddToChat={vi.fn()}
                onCopyPath={onCopyPath}
                onClose={onClose}
            />
        )

        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))
        expect(onCopyPath).toHaveBeenCalledWith('/repo/src/App.tsx')
        expect(onClose).not.toHaveBeenCalled()

        resolveCopy()
        await waitFor(() => {
            expect(onClose).toHaveBeenCalledTimes(1)
        })
    })

    it('closes on Escape and outside mouse down', () => {
        const onClose = vi.fn()
        render(
            <>
                <button type="button">outside</button>
                <EditorContextMenu
                    filePath="/repo/src/App.tsx"
                    position={{ x: 12, y: 34 }}
                    onOpen={vi.fn()}
                    onAddToChat={vi.fn()}
                    onCopyPath={vi.fn()}
                    onClose={onClose}
                />
            </>
        )

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)

        fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }))
        expect(onClose).toHaveBeenCalledTimes(2)
    })
})
