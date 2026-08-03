import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import type { ReactElement, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ComposerButtons,
    ComposerExpandButton,
    DictationButton,
    getComposerToolbarJustifyContent,
    UnifiedButton,
} from './ComposerButtons'

const adapter: ChatModelAdapter = {
    async *run() {},
}

function RuntimeProviders(props: { children: ReactNode }) {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <I18nProvider>{props.children}</I18nProvider>
        </AssistantRuntimeProvider>
    )
}

function renderInProviders(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

/**
 * Regression tests for upstream review on PR #798
 * (github-actions[bot] [Major]: "Send button advertises scratchlist
 * routing even when the submit will go to chat").
 *
 * UnifiedButton's visible state (amber + "Send to scratchlist" label
 * vs. black + "Send message" label) MUST reflect the actual routing
 * decision rather than the raw scratchlist toggle. Callers are
 * responsible for computing routesToScratchlist from
 * (mode, attachments, schedule); these tests pin the contract that
 * routesToScratchlist=false drives the chat-style render.
 */

function getButton(label: RegExp | string): HTMLButtonElement {
    return screen.getByRole('button', { name: label }) as HTMLButtonElement
}

describe('UnifiedButton — routesToScratchlist visual state', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    it('paints amber + announces "Send to scratchlist" when routesToScratchlist=true', () => {
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
                routesToScratchlist
            />,
        )
        const btn = getButton(/scratchlist/i)
        expect(btn.className).toContain('bg-amber-500')
    })

    it('paints chat black + announces "Send" when routesToScratchlist=false (e.g. pending schedule)', () => {
        // Caller computed routesToScratchlist=false because a pending schedule
        // forces chat fallback. The button must look like a normal chat send.
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
                routesToScratchlist={false}
            />,
        )
        const btn = getButton('Send')
        expect(btn.className).not.toContain('bg-amber-500')
        expect(btn.className).toContain('bg-black')
    })

    it('defaults routesToScratchlist to false when omitted', () => {
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
            />,
        )
        const btn = getButton('Send')
        expect(btn.className).not.toContain('bg-amber-500')
    })
})

describe('DictationButton', () => {
    afterEach(cleanup)

    it('keeps dictation available when an existing draft makes the main button a send button', () => {
        const onVoiceToggle = vi.fn()
        renderInProviders(
            <DictationButton
                enabled
                canSend
                voiceEnabled
                voiceStatus="disconnected"
                controlsDisabled={false}
                onVoiceToggle={onVoiceToggle}
            />,
        )

        fireEvent.click(getButton('Dictate'))
        expect(onVoiceToggle).toHaveBeenCalledOnce()
    })
})

describe('ComposerExpandButton', () => {
    afterEach(() => {
        cleanup()
    })

    it('announces and triggers expansion', () => {
        const onToggle = vi.fn()
        renderInProviders(<ComposerExpandButton expanded={false} onToggle={onToggle} />)

        const button = getButton('Expand message editor')
        expect(button.getAttribute('aria-pressed')).toBe('false')
        fireEvent.click(button)
        expect(onToggle).toHaveBeenCalledOnce()
    })

    it('announces the collapse action while expanded', () => {
        renderInProviders(<ComposerExpandButton expanded onToggle={() => {}} />)

        const button = getButton('Collapse message editor')
        expect(button.getAttribute('aria-pressed')).toBe('true')
        expect(button.className).toContain('text-[var(--app-link)]')
    })
})

describe('ComposerButtons responsive toolbar', () => {
    afterEach(cleanup)

    it('keeps toolbar actions non-shrinking inside a horizontal scroll area', () => {
        const noop = () => {}
        render(
            <RuntimeProviders>
                <div style={{ width: 320 }}>
                    <ComposerButtons
                        canSend
                        controlsDisabled={false}
                        showSettingsButton
                        onSettingsToggle={noop}
                        expanded={false}
                        onExpandedToggle={noop}
                        showTerminalButton
                        terminalDisabled={false}
                        terminalLabel="Terminal"
                        onTerminal={noop}
                        showAbortButton
                        abortDisabled={false}
                        isAborting={false}
                        onAbort={noop}
                        showSwitchButton
                        switchDisabled={false}
                        isSwitching={false}
                        onSwitch={noop}
                        voiceEnabled
                        dictationEnabled
                        voiceStatus="disconnected"
                        onVoiceToggle={noop}
                        onSend={noop}
                        onSchedule={noop}
                        onScratchlistToggle={noop}
                    />
                </div>
            </RuntimeProviders>,
        )

        const toolbar = screen.getByTestId('composer-toolbar-items')
        expect(toolbar.className).toContain('overflow-x-auto')
        const toolbarButtons = within(toolbar).getAllByRole('button')
        expect(toolbarButtons.length).toBeGreaterThanOrEqual(8)
        for (const button of toolbarButtons) {
            expect(button.closest('.shrink-0')).not.toBeNull()
        }
    })

    it('uses overflow-safe alignment for centered and right-aligned layouts', () => {
        expect(getComposerToolbarJustifyContent('center')).toBe('safe center')
        expect(getComposerToolbarJustifyContent('right')).toBe('safe end')
        expect(getComposerToolbarJustifyContent('left')).toBe('flex-start')
        expect(getComposerToolbarJustifyContent('split')).toBe('flex-start')
    })
})
