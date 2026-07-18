import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_CAPABILITIES, type ProviderReadinessMap } from '@hapi/protocol'
import { I18nProvider } from '@/lib/i18n-context'
import { AgentSelector } from './AgentSelector'

const NOW = 1_800_000_000_000

const readiness: ProviderReadinessMap = {
    claude: {
        status: 'not-authenticated',
        installed: true,
        authenticated: false,
        authCheck: 'command',
        version: '1.2.3',
        ...PROVIDER_CAPABILITIES.claude,
        checkedAt: NOW
    },
    grok: {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck: 'credential-file',
        version: '0.2.101',
        ...PROVIDER_CAPABILITIES.grok,
        checkedAt: NOW
    }
}

describe('AgentSelector provider readiness', () => {
    afterEach(() => cleanup())

    it('keeps unavailable providers visible but disabled with a reason and marks Grok experimental', () => {
        render(
            <I18nProvider>
                <AgentSelector
                    agent="claude"
                    isDisabled={false}
                    providerReadiness={readiness}
                    now={NOW}
                    onAgentChange={vi.fn()}
                />
            </I18nProvider>
        )

        expect(screen.getByDisplayValue('claude')).toBeDisabled()
        expect(screen.getByText('Claude is not authenticated.')).toBeInTheDocument()
        expect(screen.getByDisplayValue('grok')).toBeEnabled()
        expect(screen.getByText('Experimental')).toBeInTheDocument()
    })
})
