import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionListToolbarLayoutControl } from './SessionListToolbarLayoutControl'

describe('SessionListToolbarLayoutControl', () => {
    beforeEach(() => localStorage.clear())

    it('switches search presentation and restores a hidden Codex import action', () => {
        render(
            <I18nProvider>
                <SessionListToolbarLayoutControl />
            </I18nProvider>
        )

        const hiddenHeading = screen.getByRole('heading', { name: 'Hidden tools' })
        expect(hiddenHeading.nextElementSibling).toHaveTextContent('Settings and New session are fixed')

        fireEvent.click(screen.getByRole('radio', { name: 'Always-visible field' }))
        fireEvent.click(screen.getByRole('button', { name: 'Import Codex history' }))
        fireEvent.click(screen.getByRole('button', { name: 'Show' }))

        const saved = JSON.parse(localStorage.getItem('hapi-session-list-toolbar-layout') ?? '{}')
        expect(saved.searchPresentation).toBe('field')
        expect(saved.right).toContain('codexImport')
        expect(saved.hidden).not.toContain('codexImport')
    })
})
