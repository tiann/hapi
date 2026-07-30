import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ReconnectingBanner } from './ReconnectingBanner'

describe('ReconnectingBanner', () => {
    it('shows whenever the hub SSE connection is reconnecting', () => {
        render(<I18nProvider><ReconnectingBanner isReconnecting reason="error" /></I18nProvider>)

        expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
    })

    it('stays hidden while connected', () => {
        render(<I18nProvider><ReconnectingBanner isReconnecting={false} /></I18nProvider>)

        expect(screen.queryByText(/reconnecting/i)).toBeNull()
    })
})
