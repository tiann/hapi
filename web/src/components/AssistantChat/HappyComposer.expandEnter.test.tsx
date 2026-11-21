import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import {
    HappyComposer,
    resolveComposerEnterKeyAction,
} from './HappyComposer'

describe('resolveComposerEnterKeyAction', () => {
    it('forces newline semantics while expanded even when Settings prefer send', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'send',
            isExpanded: true,
            ctrlOrMeta: false,
            altKey: false,
        })).toBe('newline')
    })

    it('sends on Ctrl/Cmd+Enter while expanded', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'send',
            isExpanded: true,
            ctrlOrMeta: true,
            altKey: false,
        })).toBe('send')
    })

    it('keeps expanded Alt+Enter ignored in the current send-mode main behavior', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'send',
            isExpanded: true,
            ctrlOrMeta: false,
            altKey: true,
        })).toBe('ignore')
    })

    it('preserves newline-mode Alt+Enter behavior while expanded', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'newline',
            isExpanded: true,
            ctrlOrMeta: false,
            altKey: true,
        })).toBe('newline')
    })

    it('honors collapsed send preference for plain Enter', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'send',
            isExpanded: false,
            ctrlOrMeta: false,
            altKey: false,
        })).toBe('send')
    })

    it('honors collapsed newline preference for plain Enter and Ctrl/Cmd+Enter', () => {
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'newline',
            isExpanded: false,
            ctrlOrMeta: false,
            altKey: false,
        })).toBe('newline')
        expect(resolveComposerEnterKeyAction({
            composerEnterBehavior: 'newline',
            isExpanded: false,
            ctrlOrMeta: true,
            altKey: false,
        })).toBe('send')
    })
})

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
    useComposerDraft: (sessionId: string | undefined) => ({ sessionId, complete: true, restoredAny: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({
    useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }),
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }),
}))
vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({ isStandalone: false, isIOS: false }),
}))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}],
}))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('./PiModelPanel', () => ({ PiModelPanel: () => null }))
vi.mock('./PiThinkingLevelPanel', () => ({ PiThinkingLevelPanel: () => null }))
vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        onSend: () => void
        expanded: boolean
        onExpandedToggle: () => void
    }) => (
        <div>
            <button type="button" onClick={props.onSend}>send</button>
            <button type="button" onClick={props.onExpandedToggle}>
                {props.expanded ? 'collapse' : 'expand'}
            </button>
        </div>
    ),
}))

function ComposerHarness(props: { initialText: string }) {
    const [snapshot, setSnapshot] = useState<FakeRuntimeState>(() => ({
        composer: { text: props.initialText, attachments: [] },
        thread: { isRunning: false, isDisabled: false },
    }))
    const pendingSendIntentRef = useRef<ComposerSendIntent>('default')

    runtime.snapshot = snapshot
    runtime.setSnapshot = setSnapshot
    runtime.pendingSendIntentRef = pendingSendIntentRef

    return (
        <I18nProvider>
            <HappyComposer
                agentFlavor="claude"
                pendingSendIntentRef={pendingSendIntentRef}
            />
        </I18nProvider>
    )
}

function input(): HTMLTextAreaElement {
    return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('HappyComposer expanded Enter (Settings Enter=send)', () => {
    afterEach(() => {
        cleanup()
        runtime.pendingSendIntentRef = null
        runtime.sentIntents = []
    })

    it('does not send on plain Enter while expanded; Ctrl+Enter sends', async () => {
        render(<ComposerHarness initialText="long form draft" />)

        fireEvent.click(screen.getByRole('button', { name: 'expand' }))
        await waitFor(() => {
            expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded')
        })

        fireEvent.keyDown(input(), { key: 'Enter' })
        expect(runtime.sentIntents).toEqual([])
        expect(input()).toHaveValue('long form draft')

        fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true })
        expect(runtime.sentIntents).toEqual(['default'])
    })

    it('sends on Cmd+Enter while expanded', async () => {
        render(<ComposerHarness initialText="mac draft" />)

        fireEvent.click(screen.getByRole('button', { name: 'expand' }))
        await waitFor(() => {
            expect(screen.getByTestId('composer-shell')).toHaveAttribute('data-expanded')
        })

        fireEvent.keyDown(input(), { key: 'Enter', metaKey: true })
        expect(runtime.sentIntents).toEqual(['default'])
    })

    it('still sends on plain Enter when collapsed with Enter=send', () => {
        render(<ComposerHarness initialText="collapsed send" />)

        fireEvent.keyDown(input(), { key: 'Enter' })
        expect(runtime.sentIntents).toEqual(['default'])
    })
})
