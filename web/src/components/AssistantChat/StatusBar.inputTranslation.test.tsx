import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar, type StatusBarInputTranslation } from './StatusBar'

function renderChip(inputTranslation?: StatusBarInputTranslation) {
    render(
        <I18nProvider>
            <StatusBar active thinking={false} agentState={null} inputTranslation={inputTranslation} />
        </I18nProvider>
    )
}

describe('StatusBar input translation chip', () => {
    it('is absent when the hub offers no translation', () => {
        renderChip(undefined)
        expect(screen.queryByTestId('composer-translate-toggle')).toBeNull()
    })

    it('reflects the state and toggles in one tap', () => {
        const onToggle = vi.fn()
        renderChip({ enabled: false, fromDefault: false, pending: false, onToggle })
        const chip = screen.getByTestId('composer-translate-toggle')
        expect(chip).toHaveAttribute('aria-pressed', 'false')
        expect(chip).toHaveAccessibleName('Translate your messages to English in this session')
        fireEvent.click(chip)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('says when the state comes from the hub default and blocks double toggles', () => {
        renderChip({ enabled: true, fromDefault: true, pending: true, onToggle: vi.fn() })
        const chip = screen.getByTestId('composer-translate-toggle')
        expect(chip).toHaveAttribute('aria-pressed', 'true')
        expect(chip.getAttribute('title')).toContain('hub default')
        expect(chip).toBeDisabled()
    })
})
