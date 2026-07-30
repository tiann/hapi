import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MachineFilterBar } from './MachineFilterBar'
import { I18nProvider } from '@/lib/i18n-context'

function renderBar(props: Partial<Parameters<typeof MachineFilterBar>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineFilterBar
                machines={[
                    { id: 'machine-1', label: 'Mint', sessionCount: 3, healthPresentation: null },
                    {
                        id: 'machine-2',
                        label: 'Teemo',
                        sessionCount: 2,
                        healthPresentation: {
                            metrics: [
                                { id: 'cpu', shortLabel: 'CPU', percent: 12, tone: 'ok' },
                                { id: 'ram', shortLabel: 'RAM', percent: 88, tone: 'warn' },
                            ],
                            overallTone: 'warn',
                            status: 'elevated',
                        },
                    },
                ]}
                totalCount={5}
                value={null}
                onChange={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('MachineFilterBar', () => {
    it('renders an "All" chip plus one chip per machine with counts', () => {
        renderBar()

        expect(screen.getByRole('button', { name: /All \(5\)/ })).toBeTruthy()
        expect(screen.getByRole('button', { name: /Mint \(3\)/ })).toBeTruthy()
        expect(screen.getByRole('button', { name: /Teemo \(2\)/ })).toBeTruthy()
    })

    it('marks the selected chip as pressed', () => {
        renderBar({ value: 'machine-1' })

        expect(screen.getByRole('button', { name: /Mint \(3\)/ }).getAttribute('aria-pressed')).toBe('true')
        expect(screen.getByRole('button', { name: /All \(5\)/ }).getAttribute('aria-pressed')).toBe('false')
    })

    it('reports machine selection and reset to All', () => {
        const onChange = vi.fn()
        renderBar({ value: 'machine-1', onChange })

        fireEvent.click(screen.getByRole('button', { name: /Teemo \(2\)/ }))
        expect(onChange).toHaveBeenCalledWith('machine-2')

        fireEvent.click(screen.getByRole('button', { name: /All \(5\)/ }))
        expect(onChange).toHaveBeenCalledWith(null)
    })

    it('shows machine health in a hover popup instead of reserving chip width', () => {
        renderBar()

        const chip = screen.getByRole('button', { name: /Teemo \(2\)/ })
        const describedBy = chip.getAttribute('aria-describedby')
        expect(describedBy).toBeTruthy()

        const tooltip = document.getElementById(describedBy!)
        expect(tooltip).toBeTruthy()
        expect(tooltip!.getAttribute('role')).toBe('tooltip')
        expect(tooltip!.textContent).toContain('Machine capacity')
        expect(tooltip!.textContent).toContain('CPU')
        expect(tooltip!.textContent).toContain('12%')
        // Popup is hidden below the md breakpoint (mobile shows nothing)
        expect(tooltip!.className).toContain('max-md:hidden')
        // A pseudo-element bridges the mt-1 gap so the popup stays open while entered
        expect(tooltip!.className).toContain('before:-top-1')
    })

    it('keeps the entire visible chip clickable', () => {
        const onChange = vi.fn()
        renderBar({ onChange })

        // Chip with health popup: the button carries the pill padding, the
        // bordered wrapper adds no inert padding around it.
        const teemo = screen.getByRole('button', { name: /Teemo \(2\)/ })
        expect(teemo.className).toContain('px-2.5')
        const pill = teemo.parentElement!.parentElement!
        expect(pill.className).toContain('rounded-full')
        expect(pill.className).toContain('border')
        expect(pill.className).not.toContain('px-2.5')

        // Chip without health: the button is the pill itself.
        const mint = screen.getByRole('button', { name: /Mint \(3\)/ })
        expect(mint.className).toContain('rounded-full')
        expect(mint.className).toContain('border')
    })
})
