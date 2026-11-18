import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidebarResizeHandle, SidebarShowButton } from './SidebarToggle'

describe('SidebarResizeHandle', () => {
    it('hides the sidebar without forwarding the button pointer event to resizing', () => {
        const onHide = vi.fn()
        const onPointerDown = vi.fn()

        render(
            <SidebarResizeHandle
                canHide={true}
                hideLabel="Hide session list"
                onHide={onHide}
                onPointerDown={onPointerDown}
            />
        )

        const button = screen.getByRole('button', { name: 'Hide session list' })
        fireEvent.pointerDown(button)
        fireEvent.click(button)

        expect(onHide).toHaveBeenCalledOnce()
        expect(onPointerDown).not.toHaveBeenCalled()
        expect(button.querySelectorAll('path')).toHaveLength(1)
        expect(button.querySelector('rect'))
            .toHaveAttribute('rx', '3')
        expect(button.querySelector('rect'))
            .toHaveAttribute('fill', 'var(--app-bg)')
    })

    it('does not render a hide button on the sessions index', () => {
        render(
            <SidebarResizeHandle
                canHide={false}
                hideLabel="Hide session list"
                onHide={vi.fn()}
                onPointerDown={vi.fn()}
            />
        )

        expect(screen.queryByRole('button', { name: 'Hide session list' })).not.toBeInTheDocument()
    })
})

describe('SidebarShowButton', () => {
    it('restores the hidden session list', () => {
        const onShow = vi.fn()
        render(<SidebarShowButton showLabel="Show session list" onShow={onShow} />)

        const button = screen.getByRole('button', { name: 'Show session list' })
        fireEvent.click(button)

        expect(onShow).toHaveBeenCalledOnce()
        expect(button).toHaveClass('hidden', 'split:flex')
        const svg = button.querySelector('svg')
        expect(svg).toHaveAttribute('viewBox', '0 0 24 40')
        expect(svg).not.toHaveAttribute('preserveAspectRatio')
        expect(svg).toHaveAttribute('shape-rendering', 'geometricPrecision')
        expect(svg).toHaveAttribute('stroke-width', '2')
    })
})
