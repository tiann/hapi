import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

function renderStatusBar(props?: Partial<Parameters<typeof StatusBar>[0]>) {
    return render(
        <I18nProvider>
            <StatusBar
                active
                thinking={false}
                agentState={null}
                agentFlavor="codex"
                {...props}
            />
        </I18nProvider>
    )
}

describe('StatusBar', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows Codex reasoning effort and collaboration mode', () => {
        renderStatusBar({
            modelReasoningEffort: 'xhigh',
            serviceTier: 'fast',
            collaborationMode: 'default'
        })

        expect(screen.getByText('xhigh')).toBeInTheDocument()
        expect(screen.getByText('fast')).toBeInTheDocument()
        expect(screen.getByText('Default')).toBeInTheDocument()
    })

    it('hides Codex config labels when values are unset', () => {
        renderStatusBar()

        expect(screen.queryByText('xhigh')).not.toBeInTheDocument()
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
        expect(screen.queryByText('Default')).not.toBeInTheDocument()
    })
})
