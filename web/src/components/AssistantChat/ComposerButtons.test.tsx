import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

describe('UnifiedButton — touch queue gesture', () => {
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
    })

    function renderSendButton(overrides: Partial<ComponentProps<typeof UnifiedButton>> = {}) {
        const onSend = vi.fn()
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={onSend}
                onVoiceToggle={() => {}}
                allowQueueGesture
                {...overrides}
            />,
        )
        const label = overrides.voiceStatus === 'connected'
            ? 'Stop'
            : overrides.routesToScratchlist
                ? /scratchlist/i
                : 'Send'
        return { onSend, button: getButton(label) }
    }

    it('keeps normal native click and keyboard activation as the default send intent', () => {
        const { onSend, button } = renderSendButton()

        fireEvent.keyDown(button, { key: 'Enter' })
        expect(onSend).not.toHaveBeenCalled()
        fireEvent.click(button, { detail: 1 })

        expect(onSend).toHaveBeenCalledOnce()
        expect(onSend).toHaveBeenCalledWith('default')
    })

    it('uses queue only for a mobile touch long-press and suppresses its native click', () => {
        vi.useFakeTimers()
        const { onSend, button } = renderSendButton()

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => vi.advanceTimersByTime(500))
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button, { detail: 1 })

        expect(onSend).toHaveBeenCalledOnce()
        expect(onSend).toHaveBeenCalledWith('queue')

        fireEvent.click(button, { detail: 1 })
        expect(onSend).toHaveBeenCalledTimes(2)
        expect(onSend).toHaveBeenLastCalledWith('default')
    })

    it('keeps keyboard and assistive send activation after a long touch has no compatibility click', () => {
        vi.useFakeTimers()
        const { onSend, button } = renderSendButton()

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => vi.advanceTimersByTime(500))
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })

        // The browser does not emit its touch compatibility click. A detail-0
        // click is the native keyboard/assistive activation path.
        fireEvent.click(button, { detail: 0 })

        expect(onSend).toHaveBeenCalledTimes(2)
        expect(onSend).toHaveBeenNthCalledWith(1, 'queue')
        expect(onSend).toHaveBeenNthCalledWith(2, 'default')
    })

    it('keeps touch tap, desktop mouse hold, and desktop right-click on normal behavior', () => {
        vi.useFakeTimers()
        const { onSend, button } = renderSendButton()

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button)

        fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 10 })
        act(() => vi.advanceTimersByTime(500))
        fireEvent.mouseUp(button, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.click(button)
        const contextMenuWasNotPrevented = fireEvent.contextMenu(button, { clientX: 10, clientY: 10 })

        expect(onSend).toHaveBeenCalledTimes(2)
        expect(onSend).toHaveBeenNthCalledWith(1, 'default')
        expect(onSend).toHaveBeenNthCalledWith(2, 'default')
        expect(contextMenuWasNotPrevented).toBe(true)
    })

    it.each([
        ['voice is active', { voiceStatus: 'connected' as const }],
        ['scratchlist route is active', { routesToScratchlist: true }],
        ['queue gesture is disabled', { allowQueueGesture: false }],
    ])('does not queue on long-press when %s', (_name, overrides) => {
        vi.useFakeTimers()
        const { onSend, button } = renderSendButton(overrides)

        fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] })
        act(() => vi.advanceTimersByTime(500))
        fireEvent.touchEnd(button, { changedTouches: [{ clientX: 10, clientY: 10 }] })
        fireEvent.click(button)

        expect(onSend).not.toHaveBeenCalledWith('queue')
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
