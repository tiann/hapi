import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AgentFlavorIcon } from './AgentFlavorIcon'

function getBadge(container: HTMLElement): HTMLElement {
    const badge = container.querySelector('span')
    if (!badge) throw new Error('AgentFlavorIcon did not render a <span>')
    return badge
}

describe('AgentFlavorIcon', () => {
    it('renders the "Pi" label and purple background for the pi flavor', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Pi')
        // The Pi badge uses a specific purple; if the literal ever drifts,
        // the test should fail and force an intentional design update.
        expect(badge.className).toContain('bg-[#5b21b6]')
        expect(badge.className).toContain('text-white')
    })

    it('matches the exact class contract for all known flavors (regression)', () => {
        const cases: Array<{ flavor: string; label: string; bg: string }> = [
            { flavor: 'claude', label: 'Cl', bg: 'bg-[#d97706]' },
            { flavor: 'codex', label: 'Cx', bg: 'bg-[#111827]' },
            { flavor: 'cursor', label: 'Cu', bg: 'bg-[#0f766e]' },
            { flavor: 'gemini', label: 'Gm', bg: 'bg-[#2563eb]' },
            { flavor: 'kimi', label: 'Km', bg: 'bg-[#7c3aed]' },
            { flavor: 'pi', label: 'Pi', bg: 'bg-[#5b21b6]' },
            { flavor: 'opencode', label: 'Op', bg: 'bg-[#15803d]' },
        ]
        for (const { flavor, label, bg } of cases) {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            const badge = getBadge(container)
            expect(badge.textContent).toBe(label)
            expect(badge.className).toContain(bg)
        }
    })

    it('renders the "Un" badge with secondary-bg colors for null flavor', () => {
        const { container } = render(<AgentFlavorIcon flavor={null} />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Un')
        expect(badge.className).toContain('bg-[var(--app-secondary-bg)]')
    })

    it('renders the "Un" badge for undefined flavor', () => {
        const { container } = render(<AgentFlavorIcon flavor={undefined} />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('renders the "Un" badge for empty string', () => {
        const { container } = render(<AgentFlavorIcon flavor="" />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('renders the "Un" badge for unknown flavor strings', () => {
        const { container } = render(<AgentFlavorIcon flavor="mystery-cli" />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Un')
        expect(badge.className).toContain('bg-[var(--app-secondary-bg)]')
    })

    it('normalizes flavor case and whitespace', () => {
        // The component lowercases + trims internally so 'PI ', 'Pi', '  pi'
        // all resolve to the Pi badge.
        for (const flavor of ['PI', 'Pi', '  pi  ', 'PI ']) {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            expect(getBadge(container).textContent).toBe('Pi')
        }
    })

    it('does NOT match a flavor when only whitespace is present', () => {
        // '   '.trim() === '' so the unknown branch is the only valid one.
        const { container } = render(<AgentFlavorIcon flavor="   " />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('applies the default size classes when no className is provided', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.className).toContain('h-4')
        expect(badge.className).toContain('w-4')
    })

    it('appends the provided className alongside the badge classes', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" className="h-6 w-6" />)
        const badge = getBadge(container)
        expect(badge.className).toContain('h-6')
        expect(badge.className).toContain('w-6')
        // The default size classes must be replaced by the custom className
        // (the implementation uses `${className ?? 'h-4 w-4'}`).
        expect(badge.className).not.toContain('h-4 w-4')
    })

    it('marks the badge aria-hidden for screen readers (decorative only)', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.getAttribute('aria-hidden')).toBe('true')
    })
})
