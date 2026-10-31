import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidebarShowButton } from './SidebarToggle'

describe('SidebarShowButton', () => {
    it('restores the hidden session list', () => {
        const onShow = vi.fn()

        render(<SidebarShowButton showLabel="Show session list" onShow={onShow} />)

        const button = screen.getByRole('button', { name: 'Show session list' })
        fireEvent.click(button)

        expect(onShow).toHaveBeenCalledOnce()
        expect(button).toHaveClass('hidden', 'split:flex')
        expect(button.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 40')
    })
})
