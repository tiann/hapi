import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionLinkedBadge } from './SessionLinkedBadge'

afterEach(() => cleanup())

describe('SessionLinkedBadge', () => {
    it('calls onClick when pressed', () => {
        const onClick = vi.fn()
        render(<SessionLinkedBadge onClick={onClick} title="Open session" ariaLabel="Open session" label="Session" />)
        fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('renders the compact size by default', () => {
        render(<SessionLinkedBadge onClick={() => {}} title="t" ariaLabel="t" label="Session" />)
        expect(screen.getByRole('button').className).toContain('h-6')
    })

    it('renders the larger size when requested, matching the detail-pane footer bar', () => {
        render(<SessionLinkedBadge onClick={() => {}} title="t" ariaLabel="t" label="Session" size="md" />)
        expect(screen.getByRole('button').className).toContain('h-9')
    })

    it('uses the same accent identity at both sizes', () => {
        const { unmount } = render(<SessionLinkedBadge onClick={() => {}} title="t" ariaLabel="t" label="Session" size="sm" />)
        expect(screen.getByRole('button').className).toContain('text-[var(--app-link)]')
        unmount()
        render(<SessionLinkedBadge onClick={() => {}} title="t" ariaLabel="t" label="Session" size="md" />)
        expect(screen.getByRole('button').className).toContain('text-[var(--app-link)]')
    })
})
