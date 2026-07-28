import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AGENT_FLAVORS } from '@hapi/protocol'
import { AgentFlavorIcon } from './AgentFlavorIcon'

// Flavors backed by a @lobehub/icons brand logo. 'pi' has no logo in the
// package and intentionally falls back to the letter badge.
const LOGO_FLAVORS = AGENT_FLAVORS.filter((f) => f !== 'pi')

function getWrapper(container: HTMLElement): HTMLElement {
    const wrapper = container.querySelector('span')
    if (!wrapper) throw new Error('AgentFlavorIcon did not render a <span>')
    return wrapper
}

describe('AgentFlavorIcon', () => {
    it.each(LOGO_FLAVORS)('renders an inline SVG brand logo for the %s flavor', (flavor) => {
        const { container } = render(<AgentFlavorIcon flavor={flavor} />)
        const svg = container.querySelector('svg')
        expect(svg, `expected an SVG logo for flavor "${flavor}"`).not.toBeNull()
        // Logo variant replaces the old two-letter badge.
        expect(getWrapper(container).className).not.toContain('rounded-sm')
    })

    it('normalizes flavor case and whitespace before picking a logo', () => {
        for (const flavor of ['CLAUDE', 'Claude', '  claude  ', 'Claude ']) {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            expect(container.querySelector('svg')).not.toBeNull()
        }
    })

    it('keeps the "Pi" letter badge for the pi flavor (no brand logo available)', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getWrapper(container)
        expect(container.querySelector('svg')).toBeNull()
        expect(badge.textContent).toBe('Pi')
        expect(badge.className).toContain('bg-[#5b21b6]')
        expect(badge.className).toContain('text-white')
    })

    it.each([null, undefined, '', '   ', 'mystery-cli'])(
        'renders the "Un" fallback badge for flavor %j',
        (flavor) => {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            const badge = getWrapper(container)
            expect(container.querySelector('svg')).toBeNull()
            expect(badge.textContent).toBe('Un')
            expect(badge.className).toContain('bg-[var(--app-secondary-bg)]')
        }
    )

    it('applies the default size classes when no className is provided', () => {
        const { container } = render(<AgentFlavorIcon flavor="claude" />)
        const wrapper = getWrapper(container)
        expect(wrapper.className).toContain('h-4')
        expect(wrapper.className).toContain('w-4')
    })

    it('appends the provided className instead of the default size', () => {
        const { container } = render(<AgentFlavorIcon flavor="claude" className="h-6 w-6" />)
        const wrapper = getWrapper(container)
        expect(wrapper.className).toContain('h-6')
        expect(wrapper.className).toContain('w-6')
        expect(wrapper.className).not.toContain('h-4 w-4')
    })

    it('marks the icon aria-hidden for screen readers (decorative only)', () => {
        const { container } = render(<AgentFlavorIcon flavor="claude" />)
        expect(getWrapper(container).getAttribute('aria-hidden')).toBe('true')
    })
})
