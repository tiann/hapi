import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { TextContextThresholdSettings } from './TextContextThresholdSettings'

describe('TextContextThresholdSettings', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('shows defaults and persists custom thresholds', () => {
        render(
            <I18nProvider>
                <TextContextThresholdSettings />
            </I18nProvider>
        )

        const characters = screen.getByRole('spinbutton', {
            name: 'Auto-attach character threshold',
        })
        const lines = screen.getByRole('spinbutton', {
            name: 'Auto-attach line threshold',
        })

        expect(characters).toHaveValue(3_000)
        expect(lines).toHaveValue(60)

        fireEvent.change(characters, { target: { value: '4500' } })
        fireEvent.blur(characters)
        fireEvent.change(lines, { target: { value: '90' } })
        fireEvent.blur(lines)

        expect(localStorage.getItem('hapi-text-context-character-threshold')).toBe('4500')
        expect(localStorage.getItem('hapi-text-context-line-threshold')).toBe('90')
    })
})
