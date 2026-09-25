import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MachineFilterBar, MachineFilterMenu, getCenteredFilterMenuLeft, getMachineFilterMenuClampStyle } from './MachineFilterBar'
import { I18nProvider } from '@/lib/i18n-context'

const defaultMachines: Parameters<typeof MachineFilterBar>[0]['machines'] = [
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
]

function renderBar(props: Partial<Parameters<typeof MachineFilterBar>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineFilterBar
                machines={defaultMachines}
                totalCount={5}
                value={null}
                onChange={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

function renderMenu(props: Partial<Parameters<typeof MachineFilterMenu>[0]> = {}) {
    return render(
        <I18nProvider>
            <MachineFilterMenu
                machines={defaultMachines}
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

    it('is hidden below the md breakpoint (mobile uses MachineFilterMenu)', () => {
        renderBar()

        expect(screen.getByRole('group', { name: 'Filter by machine' }).className).toContain('max-md:hidden')
    })
})

describe('MachineFilterMenu', () => {
    it('renders a compact icon button only below the md breakpoint', () => {
        const { container } = renderMenu()

        const button = screen.getByRole('button', { name: 'Filter by machine' })
        expect(button.getAttribute('aria-haspopup')).toBe('menu')
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(container.firstElementChild!.className).toContain('md:hidden')
        // Menu stays closed until the button is pressed
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('shows an active-filter dot only when a machine is selected', () => {
        const { unmount } = renderMenu()
        const button = screen.getByRole('button', { name: 'Filter by machine' })
        expect(button.querySelector('span')).toBeNull()
        unmount()

        renderMenu({ value: 'machine-1' })
        expect(screen.getByRole('button', { name: 'Filter by machine' }).querySelector('span')).toBeTruthy()
    })

    it('opens a radio menu listing All plus every machine with counts', () => {
        renderMenu({ value: 'machine-1' })

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))

        expect(screen.getByRole('button', { name: 'Filter by machine' }).getAttribute('aria-expanded')).toBe('true')
        const all = screen.getByRole('menuitemradio', { name: /All \(5\)/ })
        const mint = screen.getByRole('menuitemradio', { name: /Mint \(3\)/ })
        const teemo = screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ })
        expect(all.getAttribute('aria-checked')).toBe('false')
        expect(mint.getAttribute('aria-checked')).toBe('true')
        expect(teemo.getAttribute('aria-checked')).toBe('false')
    })

    it('reports machine selection and closes the menu', () => {
        const onChange = vi.fn()
        renderMenu({ onChange })

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ }))

        expect(onChange).toHaveBeenCalledWith('machine-2')
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('reports reset to All and closes via the backdrop', () => {
        const onChange = vi.fn()
        renderMenu({ value: 'machine-1', onChange })

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: /All \(5\)/ }))
        expect(onChange).toHaveBeenCalledWith(null)

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))
        const backdrop = screen.getByRole('button', { name: 'Close' })
        // The invisible full-screen backdrop must not be a Tab stop
        expect(backdrop.getAttribute('tabindex')).toBe('-1')
        fireEvent.click(backdrop)
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('shows a compact inline health summary (touch devices have no hover tooltip)', () => {
        renderMenu()

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))

        const teemo = screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ })
        expect(teemo.textContent).toContain('CPU 12%')
        expect(teemo.textContent).toContain('RAM 88%')
    })

    it('combines session filters with machine filters when requested', () => {
        const onSessionFilterChange = vi.fn()
        renderMenu({
            sessionFilter: { unread: false, scratchlist: false },
            onSessionFilterChange
        })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))

        expect(screen.getByRole('group', { name: 'Session' })).toBeTruthy()
        expect(screen.getByRole('group', { name: 'Filter by machine' })).toBeTruthy()
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Scratchlist' }))
        expect(screen.getByRole('menu')).toBeTruthy()
        expect(onSessionFilterChange).toHaveBeenCalledWith({ unread: false, scratchlist: true })
    })

    it('opens the existing date picker from the unified machine menu', () => {
        renderMenu({
            sessionFilter: { unread: false, scratchlist: false },
            onSessionFilterChange: vi.fn(),
            customStart: '',
            customEnd: '',
            sessionActivityDates: new Set(),
            onDateRangeChange: vi.fn()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Date' }))

        expect(screen.getByRole('dialog', { name: 'Filter sessions by last activity' })).toBeTruthy()
    })

    it('clamps the menu to the viewport space remaining around the trigger', () => {
        const style = getMachineFilterMenuClampStyle({ right: 280, bottom: 100 })

        // Right-anchored menu: width is limited by the space left of the trigger
        expect(style.maxWidth).toContain('min(16rem, calc(280px')
        expect(style.maxWidth).toContain('env(safe-area-inset-left)')
        expect(style.maxHeight).toContain('min(20rem, calc(')
        // mt-1 gap (4px) below the trigger is part of the clamp
        expect(style.maxHeight).toContain('- 104px')
        expect(style.maxHeight).toContain('--app-viewport-height')
        expect(style.maxHeight).toContain('env(safe-area-inset-bottom)')
    })

    it('lets the session menu use intrinsic width while preserving the right gap', () => {
        const style = getMachineFilterMenuClampStyle({ right: 280, bottom: 100 }, { widthCap: null })

        expect(style.maxWidth).toBe('calc(280px - 8px - env(safe-area-inset-left))')
    })

    it('lets centered menus use the full viewport width before intrinsic sizing', () => {
        const style = getMachineFilterMenuClampStyle(
            { right: 280, bottom: 100 },
            { widthCap: null, horizontal: 'center' }
        )

        expect(style.maxWidth).toBe('calc(100vw - 16px - env(safe-area-inset-left) - env(safe-area-inset-right))')
    })

    it('centers the menu under the trigger and clamps it at viewport edges', () => {
        expect(getCenteredFilterMenuLeft({ left: 300, width: 40 }, 200, 800)).toBe(-80)
        expect(getCenteredFilterMenuLeft({ left: 0, width: 40 }, 200, 400)).toBe(8)
        expect(getCenteredFilterMenuLeft({ left: 360, width: 40 }, 200, 400)).toBe(-168)
    })

    it('focuses the selected row when the menu opens', async () => {
        renderMenu({ value: 'machine-1' })

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))

        await vi.waitFor(() => {
            expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Mint \(3\)/ }))
        })
    })

    it('moves focus with Arrow keys, wrapping at both ends', async () => {
        renderMenu()

        fireEvent.click(screen.getByRole('button', { name: 'Filter by machine' }))
        const all = screen.getByRole('menuitemradio', { name: /All \(5\)/ })
        await vi.waitFor(() => expect(document.activeElement).toBe(all))

        fireEvent.keyDown(document, { key: 'ArrowUp' })
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Teemo \(2\)/ }))

        fireEvent.keyDown(document, { key: 'ArrowDown' })
        expect(document.activeElement).toBe(all)

        fireEvent.keyDown(document, { key: 'ArrowDown' })
        expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /Mint \(3\)/ }))
    })

    it('closes on Escape and restores focus to the trigger', async () => {
        renderMenu()
        const trigger = screen.getByRole('button', { name: 'Filter by machine' })

        fireEvent.click(trigger)
        await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: /All \(5\)/ })))

        fireEvent.keyDown(document, { key: 'Escape' })

        expect(screen.queryByRole('menu')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })
})
