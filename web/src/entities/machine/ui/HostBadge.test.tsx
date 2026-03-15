import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { HostBadge } from './HostBadge'

// Mock the translation hook
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

describe('HostBadge', () => {
    it('renders with displayName', () => {
        const { container } = render(<HostBadge displayName="my-machine" />)
        expect(container.querySelector('span[role="status"]')).toBeInTheDocument()
    })

    it('renders with host', () => {
        const { container } = render(<HostBadge host="my-machine" />)
        expect(container.querySelector('span[role="status"]')).toBeInTheDocument()
    })

    it('renders with machineId', () => {
        const { container } = render(<HostBadge machineId="machine-123" />)
        expect(container.querySelector('span[role="status"]')).toBeInTheDocument()
    })

    it('returns null when no identifying props provided', () => {
        const { container } = render(<HostBadge />)
        expect(container.firstChild).toBeNull()
    })
})
