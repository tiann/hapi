import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionsModeSwitch } from './SessionsModeSwitch'

afterEach(() => cleanup())

function renderSwitch(mode: 'sessions' | 'boards' = 'sessions') {
    const onChange = () => {}
    return render(
        <I18nProvider>
            <SessionsModeSwitch mode={mode} onChange={onChange} />
        </I18nProvider>
    )
}

describe('SessionsModeSwitch FUE', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('shows the new-feature dot on the Boards toggle before first engagement', () => {
        renderSwitch()
        expect(screen.getByLabelText('New feature available')).toBeInTheDocument()
    })

    it('does not show the dot on the Sessions toggle', () => {
        renderSwitch()
        const sessionsButton = screen.getByRole('radio', { name: 'Sessions' })
        expect(sessionsButton.querySelector('[aria-label="New feature available"]')).toBeNull()
    })

    it('reveals the callout on first click and keeps the dot until dismissed', () => {
        renderSwitch()
        fireEvent.click(screen.getByRole('radio', { name: /^Boards/ }))

        expect(screen.getByRole('dialog', { name: 'Boards' })).toBeInTheDocument()
        expect(screen.getByText(/Pick which board via the switcher/)).toBeInTheDocument()
        // Still shown while the callout is open — not acknowledged yet.
        expect(screen.getByLabelText('New feature available')).toBeInTheDocument()
    })

    it('dismissing the callout hides the dot for good (persisted)', () => {
        renderSwitch()
        fireEvent.click(screen.getByRole('radio', { name: /^Boards/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))

        expect(screen.queryByRole('dialog', { name: 'Boards' })).not.toBeInTheDocument()
        expect(screen.queryByLabelText('New feature available')).not.toBeInTheDocument()
        expect(localStorage.getItem('hapi.fue.v1.boards-mode')).toBe('1')
    })

    it('does not show the dot or callout once already acknowledged', () => {
        localStorage.setItem('hapi.fue.v1.boards-mode', '1')
        renderSwitch()
        fireEvent.click(screen.getByRole('radio', { name: /^Boards/ }))

        expect(screen.queryByLabelText('New feature available')).not.toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: 'Boards' })).not.toBeInTheDocument()
    })

    it('still switches mode when clicking Boards, independent of the FUE state', () => {
        let lastMode: string | null = null
        render(
            <I18nProvider>
                <SessionsModeSwitch mode="sessions" onChange={(mode) => { lastMode = mode }} />
            </I18nProvider>
        )
        fireEvent.click(screen.getByRole('radio', { name: /^Boards/ }))
        expect(lastMode).toBe('boards')
    })
})
