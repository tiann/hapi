import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import { HappyComposer, type ComposerSendError } from './HappyComposer'

/**
 * HappyComposer owns the recovery guard, while assistant-ui owns the live
 * composer store. This focused harness supplies the small subset of that
 * store necessary to exercise send → user interaction → delayed error races.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
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
    pendingSendIntentRef: null as null | { current: ComposerSendIntent },
    sentIntents: [] as ComposerSendIntent[],
    modelChanges: [] as Array<{ provider: string; modelId: string } | string | null>,
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
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
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
                ({
                    asChild: _asChild,
                    onChange,
                    maxRows: _maxRows,
                    submitOnEnter: _submitOnEnter,
                    cancelOnEscape: _cancelOnEscape,
                    ...props
                }, ref) => (
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

vi.mock('@/lib/composerSegments', () => ({
    isRichComposerMentionsEnabled: () => false,
    resolveComposerPlaceholderKey: ({ showContinueHint }: { showContinueHint: boolean }) =>
        showContinueHint ? 'misc.typeMessage' : 'misc.typeAMessage',
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: (sessionId: string | undefined) => ({ sessionId, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        onSend: () => void
        onSchedule: (pending: PendingSchedule) => void
        onClearSchedule: () => void
        pendingSchedule: PendingSchedule | null
        expanded: boolean
        onExpandedToggle: () => void
        modelValueLabel?: string
        modelValueDisabled?: boolean
        onModelValueToggle?: () => void
    }) => (
        <div>
            <button type="button" onClick={props.onSend}>send</button>
            <button type="button" onClick={props.onExpandedToggle}>
                {props.expanded ? 'collapse' : 'expand'}
            </button>
            <button type="button" onClick={() => props.onSchedule({ type: 'absolute', ms: 9000 })}>select schedule</button>
            <button type="button" onClick={props.onClearSchedule}>clear schedule</button>
            {props.modelValueLabel ? (
                <button type="button" disabled={props.modelValueDisabled} onClick={props.onModelValueToggle}>{props.modelValueLabel}</button>
            ) : null}
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
    acceptSend: () => void
    setSending: (sending: boolean) => void
    setThreadDisabled: (disabled: boolean) => void
    settleSend: (error?: ComposerSendError) => void
    settleAttachmentSendFailure: () => void
    getClearErrorCalls: () => number
}

function ComposerHarness(props: {
    initialText: string
    initialSchedule?: PendingSchedule | null
    piRunning?: boolean
    controls: { current: HarnessControls | null }
}) {
    const [snapshot, setSnapshot] = useState<FakeRuntimeState>(() => ({
        composer: { text: props.initialText, attachments: [] },
        thread: { isRunning: props.piRunning ?? false, isDisabled: false },
    }))
    const [schedule, setSchedule] = useState<PendingSchedule | null>(props.initialSchedule ?? null)
    const [sendError, setSendError] = useState<ComposerSendError | null>(null)
    const [isSending, setIsSending] = useState(false)
    const [composerKey, setComposerKey] = useState('composer-a')
    const [sendAcceptance, setSendAcceptance] = useState<{ attemptId: string | null } | null>(null)
    const [sendSettlement, setSendSettlement] = useState<{
        attemptId: string
        status: 'success' | 'error'
    } | null>(null)
    const clearErrorCallsRef = useRef(0)
    const pendingSendIntentRef = useRef<ComposerSendIntent>('default')

    runtime.snapshot = snapshot
    runtime.setSnapshot = setSnapshot
    runtime.pendingSendIntentRef = pendingSendIntentRef
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
        acceptSend: () => {
            setIsSending(true)
            setSendSettlement(null)
            setSendAcceptance({ attemptId: 'attempt-1' })
        },
        setSending: setIsSending,
        setThreadDisabled: (disabled) => setSnapshot((current) => ({
            ...current,
            thread: { ...current.thread, isDisabled: disabled },
        })),
        settleSend: (error) => {
            if (error) setSendError(error)
            setSendSettlement({ attemptId: 'attempt-1', status: error ? 'error' : 'success' })
            setIsSending(false)
        },
        settleAttachmentSendFailure: () => {
            setSendSettlement({ attemptId: 'attempt-1', status: 'error' })
            setIsSending(false)
        },
        getClearErrorCalls: () => clearErrorCallsRef.current,
    }

    return (
        <I18nProvider>
            <HappyComposer
                key={composerKey}
                sessionId={composerKey}
                disabled={isSending}
                pendingSchedule={schedule}
                sendAcceptance={sendAcceptance}
                sendSettlement={sendSettlement}
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
                agentFlavor="pi"
                thinking={props.piRunning}
                model="pi-model"
                piModels={[{ provider: 'pi', modelId: 'pi-model', name: 'Pi model' }]}
                onModelChange={(model) => runtime.modelChanges.push(model)}
                pendingSendIntentRef={pendingSendIntentRef}
            />
        </I18nProvider>
    )
}

function renderComposer(
    initialText = 'failed text',
    initialSchedule: PendingSchedule | null = { type: 'absolute', ms: 1234 },
    piRunning = false,
) {
    const controls: { current: HarnessControls | null } = { current: null }
    runtime.sentIntents = []
    runtime.modelChanges = []
    render(<ComposerHarness initialText={initialText} initialSchedule={initialSchedule} piRunning={piRunning} controls={controls} />)
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

it('keeps Pi model selection available while a message is pending', () => {
    const controls = renderComposer()

    act(() => controls.current!.setThreadDisabled(true))

    // Mid-turn Pi keeps its model control live (#1442): the value button opens
    // the unified settings sheet, whose provider-grouped rows stay clickable.
    const valueButton = screen.getByRole('button', { name: 'Pi model' })
    expect(valueButton).not.toBeDisabled()
    fireEvent.click(valueButton)
    const modelRows = screen.getAllByRole('button', { name: 'Pi model' })
    expect(modelRows.length).toBeGreaterThan(1)
    // The sheet renders before the toolbar in the DOM, so the first match is the row.
    fireEvent.click(modelRows[0])
    expect(runtime.modelChanges).toEqual([{ provider: 'pi', modelId: 'pi-model' }])
})

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

    it('collapses an expanded composer only after an accepted send succeeds', async () => {
        const controls = renderComposer('message', null)
        fireEvent.click(screen.getByRole('button', { name: 'expand' }))
        expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded', 'true')

        send()
        expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded', 'true')

        act(() => controls.current!.acceptSend())
        expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded', 'true')

        act(() => controls.current!.settleSend())
        await waitFor(() => expect(screen.getByTestId('composer-shell')).not.toHaveAttribute('data-expanded'))
    })

    it('keeps the composer expanded when an accepted send later fails', async () => {
        const controls = renderComposer('message', null)
        fireEvent.click(screen.getByRole('button', { name: 'expand' }))
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.settleSend(fail(1, 'message', null)))

        await waitFor(() => expect(input()).toHaveValue('message'))
        expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded', 'true')
    })

    it('keeps the composer expanded when an attachment send later fails', () => {
        const controls = renderComposer('', null)
        act(() => controls.current!.addAttachment())
        fireEvent.click(screen.getByRole('button', { name: 'expand' }))
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.settleAttachmentSendFailure())

        expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded', 'true')
        expect(screen.queryByTestId('composer-send-error')).toBeNull()
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

describe('HappyComposer send intent gestures', () => {
    afterEach(() => {
        cleanup()
        runtime.pendingSendIntentRef = null
        runtime.sentIntents = []
    })

    it('ignores Alt/Option+Enter (the old explicit-queue gesture) entirely', () => {
        renderComposer('follow-up', null, true)

        fireEvent.keyDown(input(), { key: 'Enter', altKey: true })

        // Every send now queues by default (issue #1466); the Alt+Enter
        // gesture was removed with the Pi automatic steer.
        expect(runtime.sentIntents).toEqual([])
        expect(runtime.pendingSendIntentRef?.current).toBe('default')
    })

    it('uses default intent for the configured normal Enter send', () => {
        renderComposer('ordinary send', null, true)

        fireEvent.keyDown(input(), { key: 'Enter' })

        expect(runtime.sentIntents).toEqual(['default'])
        expect(runtime.pendingSendIntentRef?.current).toBe('default')
    })

    it('consumes a restored queue retry mark before resetting the shared ref', () => {
        renderComposer('retry queue', null, true)
        runtime.pendingSendIntentRef!.current = 'queue'

        fireEvent.keyDown(input(), { key: 'Enter' })

        expect(runtime.sentIntents).toEqual(['queue'])
        expect(runtime.pendingSendIntentRef?.current).toBe('default')
    })

    it('keeps Alt/Option+Enter inert when Pi is idle or a schedule is active', () => {
        const idle = renderComposer('idle', null, false)
        fireEvent.keyDown(input(), { key: 'Enter', altKey: true })
        expect(runtime.sentIntents).toEqual([])
        expect(idle.current).not.toBeNull()

        cleanup()
        renderComposer('scheduled', { type: 'absolute', ms: 1234 }, true)
        fireEvent.keyDown(input(), { key: 'Enter', altKey: true })
        expect(runtime.sentIntents).toEqual([])
        expect(runtime.pendingSendIntentRef?.current).toBe('default')
    })
})
