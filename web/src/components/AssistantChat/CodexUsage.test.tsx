import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexUsage } from './CodexUsage'
import type { CodexAccountUsage } from '@hapi/protocol/apiTypes'

const usage: CodexAccountUsage = {
    ordinary: { primary: { remainingPercent: 0, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null },
    reserve: { primary: null, secondary: { remainingPercent: 27, windowDurationMins: 10080, resetsAt: null } },
    reserveAvailable: true
}

describe('Codex usage', () => {
    it('hides unused Reserve, keeps ordinary limits alongside active Reserve, and displays exhaustion', () => {
        const view = render(<I18nProvider><CodexUsage usage={usage} model="gpt-6-astra" /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Codex usage details' }))
        expect(screen.queryByText('☾ Luna Reserve')).toBeNull()
        view.rerender(<I18nProvider><CodexUsage usage={usage} model="gpt-reserve" /></I18nProvider>)
        expect(screen.getByText('☾ Luna Reserve')).toBeTruthy()
        expect(screen.getByText('Ordinary usage')).toBeTruthy()
        expect(screen.getByText(/27% remaining/)).toBeTruthy()
        expect(screen.getByText(/0% remaining/)).toBeTruthy()
        view.rerender(<I18nProvider><CodexUsage usage={null} model="gpt-reserve" /></I18nProvider>)
        expect(screen.getAllByText('Unknown')).toHaveLength(2)
        expect(screen.queryByText(/27% remaining/)).toBeNull()
    })
})
