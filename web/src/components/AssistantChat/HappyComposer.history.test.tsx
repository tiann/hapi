import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ComposerMessageHistoryEntry } from '@/lib/composerMessageHistory'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { HappyComposer } from './HappyComposer'

type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}

type FakeRuntimeState = {
    composer: { text: string; attachments: never[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    sentTexts: [] as string[],
    enterBehavior: 'send' as 'send' | 'newline',
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot?.((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    runtime.sentTexts.push(runtime.snapshot.composer.text)
                    runtime.setSnapshot?.((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
                clearAttachments: async () => {},
                getState: () => runtime.snapshot.composer,
            }),
            thread: () => ({ cancelRun: () => {} }),
        }),
        useAuiState: (selector: (state: FakeRuntimeState) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            Attachments: () => null,
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
                            runtime.setSnapshot?.((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                            onChange?.(event)
                        }}
                    />
                ),
            ),
        },
    }
})

vi.mock('@/lib/composerSegments', () => ({
    isRichComposerMentionsEnabled: () => false,
    resolveComposerPlaceholderKey: () => 'misc.typeAMessage',
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: (sessionId: string | undefined) => ({
        sessionId,
        complete: true,
        restoredAny: false,
        hasStoredAttachments: false,
    }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({
    useComposerEnterBehavior: () => ({ composerEnterBehavior: runtime.enterBehavior }),
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
vi.mock('@/lib/use-fue', () => ({
    useFue: () => ({ status: 'acknowledged', engage: () => {}, dismiss: () => {} }),
}))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ChatInput/Autocomplete', () => ({
    Autocomplete: (props: {
        suggestions: readonly Suggestion[]
        selectedIndex: number
        onSelect: (index: number) => void
    }) => (
        <div data-testid="history-autocomplete">
            {props.suggestions.map((suggestion, index) => (
                <button
                    key={suggestion.key}
                    type="button"
                    data-selected={index === props.selectedIndex ? 'true' : undefined}
                    onClick={() => props.onSelect(index)}
                >
                    {suggestion.label}
                    {suggestion.description ? <span>{suggestion.description}</span> : null}
                </button>
            ))}
        </div>
    ),
}))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: { onSend: () => void }) => (
        <button type="button" onClick={props.onSend}>send</button>
    ),
}))

const history: ComposerMessageHistoryEntry[] = [
    { id: 'new', text: 'newest task', attachments: [], createdAt: 2 },
    {
        id: 'old',
        text: 'older task',
        attachments: [{ id: 'old.txt', filename: 'old.txt', mimeType: 'text/plain', size: 1, path: '/tmp/old.txt' }],
        createdAt: 1,
    },
]

function ComposerHarness(props: { initialText: string; messageHistory?: ComposerMessageHistoryEntry[] }) {
    const [snapshot, setSnapshot] = useState<FakeRuntimeState>(() => ({
        composer: { text: props.initialText, attachments: [] },
        thread: { isRunning: false, isDisabled: false },
    }))
    runtime.snapshot = snapshot
    runtime.setSnapshot = setSnapshot

    return (
        <I18nProvider>
            <HappyComposer
                sessionId="history-test"
                messageHistory={props.messageHistory ?? history}
                agentFlavor="pi"
                model="pi-model"
                piModels={[{ provider: 'pi', modelId: 'pi-model', name: 'Pi model' }]}
            />
        </I18nProvider>
    )
}

function setComposerValue(input: HTMLTextAreaElement, value: string, caret = value.length) {
    act(() => {
        fireEvent.change(input, { target: { value } })
        input.setSelectionRange(caret, caret)
        fireEvent.select(input)
    })
}

describe('HappyComposer message history', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.sentTexts = []
        runtime.enterBehavior = 'send'
    })

    it('opens from # or ＃, searches locally, and strips the trigger on selection', () => {
        render(<ComposerHarness initialText="" />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement

        setComposerValue(input, '#old')
        expect(screen.getByTestId('history-autocomplete')).toHaveTextContent('older task')
        expect(screen.getByTestId('history-autocomplete')).toHaveTextContent('Attachments (1) won’t be restored')
        expect(screen.getByTestId('history-autocomplete')).not.toHaveTextContent('old.txt')
        expect(screen.getByTestId('history-autocomplete')).not.toHaveTextContent('newest task')

        fireEvent.click(screen.getByRole('button', { name: /older task/ }))
        expect(input.value).toBe('older task')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()

        setComposerValue(input, '＃')
        expect(screen.getByTestId('history-autocomplete')).toHaveTextContent('newest task')
    })

    it('does not reopen when the restored message itself begins with #', () => {
        const literalHistory: ComposerMessageHistoryEntry[] = [
            { id: 'literal', text: '#literal command', attachments: [], createdAt: 1 },
        ]
        render(<ComposerHarness initialText="" messageHistory={literalHistory} />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement

        setComposerValue(input, '#literal')
        fireEvent.click(screen.getByRole('button', { name: '#literal command' }))

        expect(input.value).toBe('#literal command')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()
    })

    it('does not open when # is not the first character of the composer', () => {
        render(<ComposerHarness initialText="" />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement

        setComposerValue(input, 'text #')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()

        setComposerValue(input, 'line one\n#')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()
    })

    it('dismisses history candidates when whitespace follows the prefix', () => {
        render(<ComposerHarness initialText="" />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement

        setComposerValue(input, '#')
        expect(screen.getByTestId('history-autocomplete')).toBeInTheDocument()

        setComposerValue(input, '# ')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()
    })

    it('preserves a draft while ArrowUp navigates older entries and ArrowDown restores it', async () => {
        render(<ComposerHarness initialText="unsent draft" />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement
        input.focus()
        input.setSelectionRange(0, 0)
        fireEvent.select(input)

        fireEvent.keyDown(input, { key: 'ArrowUp' })
        await waitFor(() => expect(input.value).toBe('newest task'))

        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(input.value).toBe('older task')

        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(input.value).toBe('newest task')
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(input.value).toBe('unsent draft')
    })

    it('keeps native multiline ArrowUp behavior away from absolute offset zero', () => {
        render(<ComposerHarness initialText={'line one\nline two'} />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement
        input.focus()
        input.setSelectionRange('line one\n'.length, 'line one\n'.length)
        fireEvent.select(input)

        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(input.value).toBe('line one\nline two')
        expect(screen.queryByTestId('history-autocomplete')).toBeNull()
    })

    it('sends literal # text with Ctrl+Enter when Enter is configured for newline', () => {
        runtime.enterBehavior = 'newline'
        render(<ComposerHarness initialText="#old" />)
        const input = screen.getByRole('textbox') as HTMLTextAreaElement
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
        fireEvent.select(input)

        expect(screen.getByTestId('history-autocomplete')).toHaveTextContent('older task')
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

        expect(runtime.sentTexts).toEqual(['#old'])
    })
})
