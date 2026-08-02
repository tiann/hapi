import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { HappyComposer, type ComposerSendError } from './HappyComposer'

/**
 * HappyComposer owns the recovery guard, while assistant-ui owns the live
 * composer store. This focused harness supplies the small subset of that
 * store necessary to exercise send → user interaction → delayed error races.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: () => {} }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                ({ onChange, maxRows: _maxRows, submitOnEnter: _submitOnEnter, cancelOnEscape: _cancelOnEscape, ...props }, ref) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                            onChange?.(event)
                        }}
                    />
                ),
            ),
            Attachments: () => null,
        },
    }
})

vi.mock('@/lib/composerSegments', () => ({ isRichComposerMentionsEnabled: () => false }))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: (sessionId: string | undefined) => ({ sessionId, complete: true, restoredAny: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('./PiModelPanel', () => ({ PiModelPanel: () => null }))
vi.mock('./PiThinkingLevelPanel', () => ({ PiThinkingLevelPanel: () => null }))
vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        onSend: () => void
        onSchedule: (pending: PendingSchedule) => void
        onClearSchedule: () => void
        pendingSchedule: PendingSchedule | null
    }) => (
        <div>
            <button type="button" onClick={props.onSend}>send</button>
            <button type="button" onClick={() => props.onSchedule({ type: 'absolute', ms: 9000 })}>select schedule</button>
            <button type="button" onClick={props.onClearSchedule}>clear schedule</button>
            <output data-testid="pending-schedule">{JSON.stringify(props.pendingSchedule)}</output>
        </div>
    ),
}))

type HarnessControls = {
    setError: (error: ComposerSendError | null) => void
    addAttachment: () => void
    removeAttachments: () => void
    acceptAndClearSchedule: () => void
    remount: () => void
    programmaticSetText: (text: string) => void
    getClearErrorCalls: () => number
}

function ComposerHarness(props: { initialText: string; initialSchedule?: PendingSchedule | null; controls: { current: HarnessControls | null } }) {
    const [snapshot, setSnapshot] = useState<FakeRuntimeState>(() => ({
        composer: { text: props.initialText, attachments: [] },
        thread: { isRunning: false, isDisabled: false },
    }))
    const [schedule, setSchedule] = useState<PendingSchedule | null>(props.initialSchedule ?? null)
    const [sendError, setSendError] = useState<ComposerSendError | null>(null)
    const [composerKey, setComposerKey] = useState('composer-a')
    const clearErrorCallsRef = useRef(0)

    runtime.snapshot = snapshot
    runtime.setSnapshot = setSnapshot
    props.controls.current = {
        setError: sendError => setSendError(sendError),
        addAttachment: () => setSnapshot((current) => ({
            ...current,
            composer: {
                ...current.composer,
                attachments: [{ id: 'new-attachment', status: { type: 'complete' } }],
            },
        })),
        removeAttachments: () => setSnapshot((current) => ({
            ...current,
            composer: { ...current.composer, attachments: [] },
        })),
        acceptAndClearSchedule: () => setSchedule(null),
        remount: () => setComposerKey((key) => key === 'composer-a' ? 'composer-b' : 'composer-a'),
        programmaticSetText: (text) => setSnapshot((current) => ({
            ...current,
            composer: { ...current.composer, text },
        })),
        getClearErrorCalls: () => clearErrorCallsRef.current,
    }

    return (
        <I18nProvider>
            <HappyComposer
                key={composerKey}
                sessionId={composerKey}
                pendingSchedule={schedule}
                onSchedule={setSchedule}
                onClearSchedule={() => setSchedule(null)}
                sendError={sendError}
                onClearSendError={() => {
                    clearErrorCallsRef.current += 1
                    setSendError(null)
                }}
                onSuppressSendErrorRestore={(id) => setSendError((current) =>
                    current && current.id === id
                        ? { ...current, restoreSuppressed: true }
                        : current
                )}
            />
        </I18nProvider>
    )
}

function renderComposer(initialText = 'failed text', initialSchedule: PendingSchedule | null = { type: 'absolute', ms: 1234 }) {
    const controls: { current: HarnessControls | null } = { current: null }
    render(<ComposerHarness initialText={initialText} initialSchedule={initialSchedule} controls={controls} />)
    return controls
}

function fail(
    id: number,
    text = 'failed text',
    scheduledAt: number | null = 1234,
    mutationStarted = true,
): ComposerSendError {
    return { id, text, scheduledAt, mutationStarted, restoreSuppressed: false, message: `failed-${id}` }
}

function send() {
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
}

function acceptAndClearSchedule(controls: { current: HarnessControls | null }) {
    act(() => controls.current!.acceptAndClearSchedule())
}

function setError(controls: { current: HarnessControls | null }, error: ComposerSendError) {
    act(() => controls.current!.setError(error))
}

function input(): HTMLTextAreaElement {
    return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('HappyComposer send-error atomic restore', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
    })

    it('restores untouched text and its absolute schedule after accepted-send clear', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue('failed text'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":1234}')
    })

    it('restores text but preserves the original schedule when rejection happens before mutation acceptance', async () => {
        const controls = renderComposer()
        send()
        setError(controls, fail(1, 'failed text', 1234, false))

        await waitFor(() => expect(input()).toHaveValue('failed text'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":1234}')
    })

    it('waits for delayed accepted-send clear when the mutation error arrives first', async () => {
        const controls = renderComposer()
        send()
        setError(controls, fail(1))

        expect(input()).toHaveValue('')
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":1234}')

        acceptAndClearSchedule(controls)

        await waitFor(() => expect(input()).toHaveValue('failed text'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":1234}')
    })

    it('restores after a keyed composer remount when no new draft interaction occurs', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        act(() => controls.current!.remount())
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue('failed text'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":1234}')
    })

    it('does not implicitly restore after a keyed remount receives a new draft interaction', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        act(() => controls.current!.remount())
        fireEvent.change(input(), { target: { value: 'new session draft' } })
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue('new session draft'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('clears a safely restored error after a programmatic text replacement so a remount preserves the replacement', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(1))
        await waitFor(() => expect(input()).toHaveValue('failed text'))
        expect(screen.getByTestId('composer-send-error')).toBeTruthy()

        act(() => controls.current!.programmaticSetText('queued replacement'))

        await waitFor(() => expect(screen.queryByTestId('composer-send-error')).toBeNull())
        expect(input()).toHaveValue('queued replacement')

        act(() => controls.current!.remount())
        expect(input()).toHaveValue('queued replacement')
        expect(screen.queryByTestId('composer-send-error')).toBeNull()
    })

    it('clears a safely restored error after a programmatic attachment replacement', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(1))
        await waitFor(() => expect(input()).toHaveValue('failed text'))

        act(() => controls.current!.addAttachment())

        await waitFor(() => expect(screen.queryByTestId('composer-send-error')).toBeNull())
    })

    it('keeps the restored error through a direct retry clear, then evaluates a new error id', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(1))
        await waitFor(() => expect(input()).toHaveValue('failed text'))
        const clearCallsBeforeRetry = controls.current!.getClearErrorCalls()

        send()

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(screen.getByTestId('composer-send-error')).toBeTruthy()
        expect(controls.current!.getClearErrorCalls()).toBe(clearCallsBeforeRetry)

        // Simulates the A -> B -> A keyed remount during the retry. The route
        // keeps the old alert visible but marks it restore-suppressed.
        act(() => controls.current!.remount())
        expect(input()).toHaveValue('')
        expect(screen.getByTestId('composer-send-error')).toBeTruthy()

        // A route success clears the retained alert without restoring text.
        act(() => controls.current!.setError(null))
        expect(screen.queryByTestId('composer-send-error')).toBeNull()
        expect(input()).toHaveValue('')

        // A later failed retry is a new, unsuppressed id and restores normally.
        acceptAndClearSchedule(controls)
        setError(controls, fail(2, 'retry failed', 5678))

        await waitFor(() => expect(input()).toHaveValue('retry failed'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":5678}')
    })

    it('keeps a new text draft and does not restore the old schedule', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        fireEvent.change(input(), { target: { value: 'new draft' } })
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue('new draft'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('does not restore after a user types then deletes back to empty', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        fireEvent.change(input(), { target: { value: 'replacement' } })
        fireEvent.change(input(), { target: { value: '' } })
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('does not restore after a new attachment is added then removed', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        act(() => controls.current!.addAttachment())
        act(() => controls.current!.removeAttachments())
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('handles an attachments-only failed send without restoring text or a schedule', async () => {
        const controls = renderComposer('', null)
        act(() => controls.current!.addAttachment())
        send()
        setError(controls, fail(1, '', null))

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('does not restore after the user selects then clears a new schedule', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        fireEvent.click(screen.getByRole('button', { name: 'select schedule' }))
        fireEvent.click(screen.getByRole('button', { name: 'clear schedule' }))
        setError(controls, fail(1))

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })

    it('evaluates a later error id against a new send instead of deduping matching text', async () => {
        const controls = renderComposer()
        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(1, 'same text', 1234))
        await waitFor(() => expect(input()).toHaveValue('same text'))

        send()
        acceptAndClearSchedule(controls)
        setError(controls, fail(2, 'same text', 5678))

        await waitFor(() => expect(input()).toHaveValue('same text'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('{"type":"absolute","ms":5678}')
    })

    it('restores text alone for an immediate failed send', async () => {
        const controls = renderComposer('immediate', null)
        send()
        setError(controls, fail(1, 'immediate', null))

        await waitFor(() => expect(input()).toHaveValue('immediate'))
        expect(screen.getByTestId('pending-schedule')).toHaveTextContent('null')
    })
})
