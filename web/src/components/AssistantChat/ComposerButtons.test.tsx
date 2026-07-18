import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@assistant-ui/react', () => ({
    ComposerPrimitive: {
        AddAttachment: ({ children, ...props }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
            <button type="button" {...props}>{children}</button>
        )
    }
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => ({
            'composer.snippets': 'Snippets',
            'composer.attach': 'Attach file',
            'composer.send': 'Send'
        })[key] ?? key
    })
}))

import { ComposerButtons } from './ComposerButtons'

function renderButtons(overrides: Partial<Parameters<typeof ComposerButtons>[0]> = {}) {
    const props: Parameters<typeof ComposerButtons>[0] = {
        canSend: false,
        controlsDisabled: false,
        showSettingsButton: false,
        onSettingsToggle: vi.fn(),
        showSnippetsButton: true,
        snippetsActive: false,
        onSnippetsToggle: vi.fn(),
        showTerminalButton: false,
        terminalDisabled: false,
        terminalLabel: 'Terminal',
        onTerminal: vi.fn(),
        showAbortButton: false,
        abortDisabled: true,
        isAborting: false,
        onAbort: vi.fn(),
        showSwitchButton: false,
        switchDisabled: true,
        isSwitching: false,
        onSwitch: vi.fn(),
        voiceEnabled: false,
        voiceStatus: 'disconnected',
        onVoiceToggle: vi.fn(),
        onSend: vi.fn(),
        ...overrides
    }
    render(<ComposerButtons {...props} />)
    return props
}

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('ComposerButtons snippets button', () => {
    it('renders a snippets button and calls the toggle handler', () => {
        const props = renderButtons()

        fireEvent.click(screen.getByLabelText('Snippets'))

        expect(props.onSnippetsToggle).toHaveBeenCalledTimes(1)
    })

    it('marks the snippets button as pressed when active', () => {
        renderButtons({ snippetsActive: true })

        expect(screen.getByLabelText('Snippets')).toHaveAttribute('aria-pressed', 'true')
    })
})
