import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { AgyModelSelector } from './AgyModelSelector'

afterEach(cleanup)

function renderSelector(overrides: Partial<Parameters<typeof AgyModelSelector>[0]> = {}) {
    render(
        <I18nProvider>
            <AgyModelSelector
                machineId="machine-1"
                isLoading={false}
                error={null}
                availableModels={[]}
                selectedModel={null}
                onModelChange={() => {}}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('AgyModelSelector', () => {
    it('says it is fetching models, which is what the wait is actually spent on', () => {
        renderSelector({ isLoading: true })

        expect(screen.getByText('Fetching available models…')).toBeInTheDocument()
        expect(screen.queryByText(/authentication/i)).not.toBeInTheDocument()
    })

    it('still calls out authentication when that is what the machine reported', () => {
        renderSelector({ error: 'Authentication required. Please run `agy` in a terminal to sign in with Google.' })

        expect(screen.getByTestId('agy-model-auth-error')).toBeInTheDocument()
    })

})
