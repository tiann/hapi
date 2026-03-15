import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ViewSelector } from './ViewSelector'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

describe('ViewSelector', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders all three view buttons', () => {
        render(
            <ViewSelector
                currentView="chat"
                onViewChange={vi.fn()}
            />
        )

        expect(screen.getByLabelText('view.chat')).toBeInTheDocument()
        expect(screen.getByLabelText('view.files')).toBeInTheDocument()
        expect(screen.getByLabelText('view.terminal')).toBeInTheDocument()
    })

    it('highlights the current view', () => {
        render(
            <ViewSelector
                currentView="files"
                onViewChange={vi.fn()}
            />
        )

        const filesButton = screen.getByLabelText('view.files')
        expect(filesButton).toHaveAttribute('aria-pressed', 'true')
    })

    it('calls onViewChange when clicking a different view', async () => {
        const onViewChange = vi.fn()

        render(
            <ViewSelector
                currentView="chat"
                onViewChange={onViewChange}
            />
        )

        const filesButton = screen.getByLabelText('view.files')
        fireEvent.click(filesButton)

        expect(onViewChange).toHaveBeenCalledWith('files')
    })

    it('calls onViewChange with terminal when clicking terminal button', async () => {
        const onViewChange = vi.fn()

        render(
            <ViewSelector
                currentView="chat"
                onViewChange={onViewChange}
            />
        )

        const terminalButton = screen.getByLabelText('view.terminal')
        fireEvent.click(terminalButton)

        expect(onViewChange).toHaveBeenCalledWith('terminal')
    })

    it('marks only the current view as pressed', () => {
        render(
            <ViewSelector
                currentView="terminal"
                onViewChange={vi.fn()}
            />
        )

        expect(screen.getByLabelText('view.chat')).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByLabelText('view.files')).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByLabelText('view.terminal')).toHaveAttribute('aria-pressed', 'true')
    })

    it('renders SVG icons for each view', () => {
        const { container } = render(
            <ViewSelector
                currentView="chat"
                onViewChange={vi.fn()}
            />
        )

        const svgs = container.querySelectorAll('svg')
        expect(svgs.length).toBe(3)
    })

    it('allows switching between all views', async () => {
        const onViewChange = vi.fn()

        render(
            <ViewSelector
                currentView="chat"
                onViewChange={onViewChange}
            />
        )

        fireEvent.click(screen.getByLabelText('view.files'))
        expect(onViewChange).toHaveBeenCalledWith('files')

        fireEvent.click(screen.getByLabelText('view.terminal'))
        expect(onViewChange).toHaveBeenCalledWith('terminal')

        fireEvent.click(screen.getByLabelText('view.chat'))
        expect(onViewChange).toHaveBeenCalledWith('chat')
    })
})
