import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { ComposerButtons } from './ComposerButtons'

vi.mock('@assistant-ui/react', () => ({
    ComposerPrimitive: {
        AddAttachment: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
            <button type="button" {...props}>{children}</button>
        ),
    },
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

function renderButtons(overrides: Partial<Parameters<typeof ComposerButtons>[0]> = {}) {
    const props: Parameters<typeof ComposerButtons>[0] = {
        canSend: false,
        controlsDisabled: false,
        showSettingsButton: false,
        onSettingsToggle: vi.fn(),
        showTerminalButton: false,
        terminalDisabled: false,
        terminalLabel: 'Terminal',
        onTerminal: vi.fn(),
        showAbortButton: false,
        abortDisabled: false,
        isAborting: false,
        onAbort: vi.fn(),
        showSwitchButton: false,
        switchDisabled: false,
        isSwitching: false,
        onSwitch: vi.fn(),
        voiceEnabled: false,
        voiceStatus: 'disconnected',
        onVoiceToggle: vi.fn(),
        onSend: vi.fn(),
        ...overrides,
    }

    render(<ComposerButtons {...props} />)
    return props
}

describe('ComposerButtons', () => {
    afterEach(() => {
        cleanup()
    })

    it('shows a mobile skill picker button when enabled', () => {
        const onSkillPickerOpen = vi.fn()
        renderButtons({
            showSkillPickerButton: true,
            onSkillPickerOpen,
        })

        const button = screen.getByRole('button', { name: 'Skills' })
        expect(button).toHaveClass('sm:hidden')

        fireEvent.click(button)
        expect(onSkillPickerOpen).toHaveBeenCalled()
    })

    it('omits the skill picker button when disabled by caller', () => {
        renderButtons({ showSkillPickerButton: false })

        expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument()
    })

    it('disables the skill picker button with composer controls', () => {
        renderButtons({
            showSkillPickerButton: true,
            controlsDisabled: true,
        })

        expect(screen.getByRole('button', { name: 'Skills' })).toBeDisabled()
    })
})
