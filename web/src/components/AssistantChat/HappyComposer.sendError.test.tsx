import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useCallback, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { getComposerDraftRevision, resetComposerSendStateForTests } from '@/lib/composer-send-state'

vi.mock('@/lib/clearDraftsAfterSend', () => ({
    clearDraftsAfterSend: vi.fn(),
}))

import { HappyComposer, type ComposerSendError } from './HappyComposer'

const mockClearDraftsAfterSend = vi.mocked(clearDraftsAfterSend)

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
    restoredAttachmentIds: null as null | ((ids: readonly string[]) => void),
    attachmentRemove: null as null | (() => void),
    attachmentReorder: null as null | ((activeId: string, targetId: string, position: 'before' | 'after') => void),
    dictationTextChange: null as null | ((text: string) => void),
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
                clearAttachments: async () => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, attachments: [] },
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
            Attachments: (props: { components?: { Attachment?: React.ComponentType } }) => {
                const Attachment = props.components?.Attachment
                return Attachment ? <Attachment /> : null
            },
        },
    }
})

vi.mock('@/lib/composerSegments', () => ({
    isRichComposerMentionsEnabled: () => false,
    resolveComposerPlaceholderKey: ({ showContinueHint }: { showContinueHint: boolean }) =>
        showContinueHint ? 'misc.typeMessage' : 'misc.typeAMessage',
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: (
        sessionId: string | undefined,
        _composerText: string,
        _attachments: readonly FakeAttachment[],
        _canRestoreAttachments: boolean,
        _setText: (text: string) => void,
        _addAttachment: (file: File) => Promise<void>,
        onRestoredAttachmentIds?: (ids: readonly string[]) => void,
    ) => {
        runtime.restoredAttachmentIds = onRestoredAttachmentIds ?? null
        return { sessionId, complete: true, restoredAny: false, hasStoredAttachments: false }
    },
}))
vi.mock('@/hooks/useDictation', () => ({
    useDictation: (config: { onTextChange: (text: string) => void }) => {
        runtime.dictationTextChange = config.onTextChange
        return {
            supported: false,
            status: 'disconnected',
            error: null,
            partialTranscript: '',
            toggle: async () => {},
        }
    },
}))
vi.mock('@/components/AssistantChat/AttachmentItem', () => ({
    AttachmentItem: (props: { onRemove?: () => void }) => {
        runtime.attachmentRemove = props.onRemove ?? null
        return null
    },
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/components/AssistantChat/SortableComposerAttachments', () => ({
    SortableComposerAttachments: (props: {
        onRemove?: () => void
        onReorder?: (activeId: string, targetId: string, position: 'before' | 'after') => void
    }) => {
        runtime.attachmentRemove = props.onRemove ?? null
        runtime.attachmentReorder = props.onReorder ?? null
        return null
    },
}))
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
    queuedEditSetText: (text: string) => void
    scratchlistPromoteSetText: (text: string) => void
    hydrateSubmittedAttachment: () => void
    hydrateReorderableAttachments: () => void
    reorderAttachments: () => void
    dictationSetText: (text: string) => void
    acceptSend: () => void
    setSending: (sending: boolean) => void
    setThreadDisabled: (disabled: boolean) => void
    settleSend: (error?: ComposerSendError) => void
    settleRetrySend: () => void
    settleAttachmentSendFailure: () => void
    resumeSameSession: () => void
    getClearErrorCalls: () => number
}

function ComposerHarness(props: {
    initialText: string
    initialSchedule?: PendingSchedule | null
    piRunning?: boolean
    sessionId?: string
    canRestoreAttachments?: boolean
    controls: { current: HarnessControls | null }
}) {
    const [snapshot, setSnapshot] = useState<FakeRuntimeState>(() => ({
        composer: { text: props.initialText, attachments: [] },
        thread: { isRunning: props.piRunning ?? false, isDisabled: false },
    }))
    const [schedule, setSchedule] = useState<PendingSchedule | null>(props.initialSchedule ?? null)
    const [sendError, setSendError] = useState<ComposerSendError | null>(null)
    const [isSending, setIsSending] = useState(false)
    const [canRestoreAttachments, setCanRestoreAttachments] = useState(props.canRestoreAttachments ?? true)
    const [composerKey, setComposerKey] = useState('composer-a')
    const [programmaticEditRevision, setProgrammaticEditRevision] = useState(0)
    const [sendAcceptance, setSendAcceptance] = useState<{
        attemptId: string | null
        sessionId: string
        programmaticEditRevision: number
        draftRevision: number
    } | null>(null)
    const [sendSettlement, setSendSettlement] = useState<{
        attemptId: string
        sessionId: string
        text: string
        status: 'success' | 'error'
        source: 'send' | 'retry'
    } | null>(null)
    const sessionId = props.sessionId ?? 'session-a'
    const consumeSendSettlement = useCallback((attemptId: string) => {
        setSendSettlement((current) =>
            current?.attemptId === attemptId ? null : current
        )
    }, [])
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
        removeAttachments: () => {
            runtime.attachmentRemove?.()
            setSnapshot((current) => ({
                ...current,
                composer: { ...current.composer, attachments: [] },
            }))
        },
        acceptAndClearSchedule: () => setSchedule(null),
        remount: () => setComposerKey((key) => key === 'composer-a' ? 'composer-b' : 'composer-a'),
        programmaticSetText: (text) => setSnapshot((current) => ({
            ...current,
            composer: { ...current.composer, text },
        })),
        queuedEditSetText: (text) => {
            setProgrammaticEditRevision((revision) => revision + 1)
            setSnapshot((current) => ({
                ...current,
                composer: { ...current.composer, text },
            }))
        },
        scratchlistPromoteSetText: (text) => {
            setProgrammaticEditRevision((revision) => revision + 1)
            setSnapshot((current) => ({
                ...current,
                composer: { ...current.composer, text },
            }))
        },
        hydrateSubmittedAttachment: () => {
            runtime.restoredAttachmentIds?.(['new-attachment'])
            setSnapshot((current) => ({
                ...current,
                composer: {
                    ...current.composer,
                    attachments: [{ id: 'new-attachment', status: { type: 'complete' } }],
                },
            }))
        },
        hydrateReorderableAttachments: () => {
            runtime.restoredAttachmentIds?.(['new-attachment', 'second-attachment'])
            setSnapshot((current) => ({
                ...current,
                composer: {
                    ...current.composer,
                    text: 'foo',
                    attachments: [
                        { id: 'new-attachment', status: { type: 'complete' } },
                        { id: 'second-attachment', status: { type: 'complete' } },
                    ],
                },
            }))
        },
        reorderAttachments: () => runtime.attachmentReorder?.('new-attachment', 'second-attachment', 'after'),
        dictationSetText: (text) => runtime.dictationTextChange?.(text),
        acceptSend: () => {
            setIsSending(true)
            setSendSettlement(null)
            setSendAcceptance({
                attemptId: 'attempt-1',
                sessionId,
                programmaticEditRevision,
                draftRevision: getComposerDraftRevision(sessionId),
            })
        },
        setSending: setIsSending,
        setThreadDisabled: (disabled) => setSnapshot((current) => ({
            ...current,
            thread: { ...current.thread, isDisabled: disabled },
        })),
        settleSend: (error) => {
            if (error) setSendError(error)
            setSendSettlement({
                attemptId: 'attempt-1',
                sessionId,
                text: props.initialText,
                status: error ? 'error' : 'success',
                source: 'send',
            })
            setIsSending(false)
        },
        settleRetrySend: () => {
            setSendSettlement({
                attemptId: 'retry-1',
                sessionId,
                text: props.initialText,
                status: 'success',
                source: 'retry',
            })
            setIsSending(false)
        },
        settleAttachmentSendFailure: () => {
            setSendSettlement({
                attemptId: 'attempt-1',
                sessionId,
                text: props.initialText,
                status: 'error',
                source: 'send',
            })
            setIsSending(false)
        },
        resumeSameSession: () => {
            setCanRestoreAttachments(true)
            setSnapshot((current) => ({
                ...current,
                composer: { ...current.composer, text: props.initialText },
            }))
        },
        getClearErrorCalls: () => clearErrorCallsRef.current,
    }

    return (
        <I18nProvider>
            <HappyComposer
                key={composerKey}
                sessionId={sessionId}
                disabled={isSending}
                pendingSchedule={schedule}
                canRestoreAttachments={canRestoreAttachments}
                sendAcceptance={sendAcceptance}
                programmaticEditRevision={programmaticEditRevision}
                sendSettlement={sendSettlement}
                onConsumeSendSettlement={consumeSendSettlement}
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
    sessionId = 'session-a',
    canRestoreAttachments = true,
) {
    const controls: { current: HarnessControls | null } = { current: null }
    runtime.sentIntents = []
    runtime.modelChanges = []
    render(<ComposerHarness initialText={initialText} initialSchedule={initialSchedule} piRunning={piRunning} sessionId={sessionId} canRestoreAttachments={canRestoreAttachments} controls={controls} />)
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
        runtime.restoredAttachmentIds = null
        runtime.attachmentRemove = null
        resetComposerSendStateForTests()
        mockClearDraftsAfterSend.mockReset()
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

    it('clears an untouched remounted send draft after a successful settlement', async () => {
        const controls = renderComposer('submitted text', null)
        send()
        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.programmaticSetText('submitted text'))

        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))
        fireEvent.change(input(), { target: { value: 'new draft after send' } })
        expect(input()).toHaveValue('new draft after send')
    })

    it('clears a remounted draft from the original user submission after success', async () => {
        const controls = renderComposer('submitted text', null)
        fireEvent.change(input(), { target: { value: 'submitted text' } })
        send()
        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.programmaticSetText('submitted text'))

        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))
    })

    it('preserves a new user draft typed during a remounted send', async () => {
        const controls = renderComposer('submitted text', null)
        send()
        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        fireEvent.change(input(), { target: { value: 'new draft while pending' } })

        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('new draft while pending'))
    })

    it('preserves a different remounted draft after a successful settlement', async () => {
        const controls = renderComposer('submitted text', null)
        send()
        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.programmaticSetText('replacement draft'))

        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('replacement draft'))
    })

    it('preserves a same-text programmatic replacement during an accepted send', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.queuedEditSetText('foo'))
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
    })

    it('preserves a same-text queued edit after the composer remounts', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.queuedEditSetText('foo'))
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()

        act(() => controls.current!.remount())
        await waitFor(() => expect(input()).toHaveValue('foo'))
    })

    it('preserves a same-text user draft after a keyed remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        fireEvent.change(input(), { target: { value: 'foo' } })
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('clears stale text restored by a same-session resume', async () => {
        const controls = renderComposer('foo', null, false, 'session-a', false)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.resumeSameSession())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))
        await waitFor(() => expect(runtime.snapshot.composer.attachments).toHaveLength(0))
        expect(mockClearDraftsAfterSend).toHaveBeenCalledWith('session-a', null, 'foo')
    })

    it('preserves a same-text edit made before resumed acceptance is published', async () => {
        const controls = renderComposer('foo', null)
        act(() => controls.current!.programmaticSetText(''))
        fireEvent.change(input(), { target: { value: 'foo' } })

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a matching draft when an attachment is added after the send', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.programmaticSetText('foo'))
        act(() => controls.current!.addAttachment())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a same-text dictation draft after a remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.dictationSetText('foo'))
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('clears sent attachments restored by draft hydration after a remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.hydrateSubmittedAttachment())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(mockClearDraftsAfterSend).toHaveBeenCalledWith('session-a', null, 'foo')
    })

    it('preserves a reordered restored attachment draft after a remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.hydrateReorderableAttachments())
        act(() => controls.current!.reorderAttachments())
        expect(getComposerDraftRevision('session-a')).toBe(1)
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a same-text schedule change after a remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.programmaticSetText('foo'))
        fireEvent.click(screen.getByRole('button', { name: 'select schedule' }))
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a same-text draft after removing a hydrated attachment', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.hydrateSubmittedAttachment())
        act(() => controls.current!.programmaticSetText('foo'))
        act(() => controls.current!.removeAttachments())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a same-text scratchlist promotion after a remount', async () => {
        const controls = renderComposer('foo', null)
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.remount())
        act(() => controls.current!.scratchlistPromoteSetText('foo'))
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
        expect(mockClearDraftsAfterSend).not.toHaveBeenCalled()
    })

    it('preserves a matching draft when a retry settles without composer acceptance', async () => {
        const controls = renderComposer('foo', null)

        act(() => controls.current!.settleRetrySend())

        await waitFor(() => expect(input()).toHaveValue('foo'))
    })

    it('clears the matching draft in the resolved target session after success', async () => {
        // The target session id models an inactive-session resume that retargets
        // the accepted send from its original route to this composer.
        const controls = renderComposer('foo', null, false, 'session-resolved')
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))
        expect(mockClearDraftsAfterSend).toHaveBeenCalledWith('session-resolved', null, 'foo')
    })

    it('preserves a later same-text draft after success and a session remount', async () => {
        const controls = renderComposer('foo', null)
        fireEvent.change(input(), { target: { value: 'foo' } })
        send()

        act(() => controls.current!.acceptSend())
        act(() => controls.current!.settleSend())

        await waitFor(() => expect(input()).toHaveValue(''))

        fireEvent.change(input(), { target: { value: 'foo' } })
        act(() => controls.current!.remount())

        await waitFor(() => expect(input()).toHaveValue('foo'))
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
