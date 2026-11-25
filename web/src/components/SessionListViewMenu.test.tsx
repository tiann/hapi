import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { DEFAULT_SESSION_LIST_VIEW, type SessionListView } from '@/hooks/useSessionListView'
import { SessionListViewMenu } from './SessionListViewMenu'

afterEach(cleanup)

function renderMenu(view: SessionListView = DEFAULT_SESSION_LIST_VIEW) {
    const onChange = vi.fn()
    const onReset = vi.fn()
    render(
        <I18nProvider>
            <SessionListViewMenu view={view} onChange={onChange} onReset={onReset} />
        </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter' }))
    return { onChange, onReset }
}

describe('SessionListViewMenu', () => {
    it('shows the current sort, status and active-first choices', () => {
        renderMenu()
        expect(screen.getByRole('menuitemradio', { name: 'Last message' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('menuitemradio', { name: 'All sessions' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('menuitemcheckbox', { name: 'Active first' })).toHaveAttribute('aria-checked', 'true')
        expect(screen.queryByRole('menuitem', { name: 'Reset to default' })).toBeNull()
    })

    it('applies choices and stays open so they can be combined', () => {
        const { onChange } = renderMenu()
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Date created' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Archived only' }))
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Active first' }))
        expect(onChange.mock.calls).toEqual([[{ sort: 'created' }], [{ status: 'archived' }], [{ activeFirst: false }]])
        expect(screen.getByRole('menu')).toBeTruthy()
    })

    it('marks a customized view and offers a reset', () => {
        const { onReset } = renderMenu({ ...DEFAULT_SESSION_LIST_VIEW, status: 'active' })
        fireEvent.click(screen.getByRole('menuitem', { name: 'Reset to default' }))
        expect(onReset).toHaveBeenCalledOnce()
    })
})

describe('SessionListViewMenu FUE', () => {
    afterEach(() => {
        window.localStorage.removeItem('hapi.fue.v1.session-list-view-menu')
    })

    it('shows a pulsing FUE dot on the trigger until acknowledged', () => {
        render(
            <I18nProvider>
                <SessionListViewMenu view={DEFAULT_SESSION_LIST_VIEW} onChange={vi.fn()} onReset={vi.fn()} />
            </I18nProvider>
        )
        const trigger = screen.getByRole('button', { name: 'Sort and filter' })
        expect(within(trigger).getByRole('status', { name: 'New feature available' })).toBeInTheDocument()
    })

    it('opens the menu and shows the explainer on first click', () => {
        renderMenu()
        expect(screen.getByRole('menu')).toBeInTheDocument()
        expect(screen.getByRole('dialog', { name: 'New: sort & filter' })).toBeInTheDocument()
    })

    it('dismisses and persists acknowledgement on Got it', () => {
        renderMenu()
        fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
        expect(window.localStorage.getItem('hapi.fue.v1.session-list-view-menu')).toBe('1')
        expect(screen.queryByRole('dialog', { name: 'New: sort & filter' })).not.toBeInTheDocument()
    })
})
