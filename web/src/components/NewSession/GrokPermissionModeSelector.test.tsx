import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { GrokPermissionModeSelector } from './GrokPermissionModeSelector'

describe('GrokPermissionModeSelector', () => {
    it('offers Auto when Grok advertises the account feature', () => {
        render(<I18nProvider>
            <GrokPermissionModeSelector
                agent="grok"
                value="default"
                autoPermissionModeSupported={true}
                isDisabled={false}
                onChange={vi.fn()}
            />
        </I18nProvider>)

        expect(screen.getByRole('option', { name: 'Auto' })).not.toBeDisabled()
    })

    it('shows Auto as unavailable when Grok does not advertise it', () => {
        render(<I18nProvider>
            <GrokPermissionModeSelector
                agent="grok"
                value="default"
                autoPermissionModeSupported={false}
                isDisabled={false}
                onChange={vi.fn()}
            />
        </I18nProvider>)

        expect(screen.getByRole('option', { name: 'Auto (unavailable)' })).toBeDisabled()
        expect(screen.getByText(/did not enable Auto permissions/i)).toBeInTheDocument()
    })
})
