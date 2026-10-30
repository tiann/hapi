import { fireEvent, render, screen } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    fitSingleLineFontSize,
    mirrorOffsetFromPoint,
    RichComposerInput,
    type RichComposerInputHandle,
    segmentsFromEditor,
} from './RichComposerInput'
import { serializeComposerSegments } from '@/lib/composerSegments'

function selectionOffset(root: HTMLElement): number {
    const selection = window.getSelection()
    expect(selection?.rangeCount).toBe(1)
    const range = selection!.getRangeAt(0)
    return mirrorOffsetFromPoint(root, range.startContainer, range.startOffset)
}

function placeCaret(textNode: Text, offset: number): void {
    const range = document.createRange()
    range.setStart(textNode, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
}

function SynchronousControlledHarness() {
    const [value, setValue] = useState('alpha')
    const [, setMirrorVersion] = useState(0)

    return (
        <>
            <button type="button" onClick={() => setValue('external draft')}>
                Replace draft
            </button>
            <output data-testid="controlled-value">{value}</output>
            <RichComposerInput
                value={value}
                // Mirrors ComposerPrimitive.Input's required same-tick controlled
                // acknowledgement. onMirrorChange intentionally re-renders too.
                onValueChange={(next) => {
                    flushSync(() => setValue(next))
                }}
                onMirrorChange={() => {
                    setMirrorVersion((version) => version + 1)
                }}
            />
        </>
    )
}

function ProgrammaticEditHarness() {
    const [value, setValue] = useState('')
    const ref = useRef<RichComposerInputHandle>(null)

    return (
        <>
            <button type="button" onClick={() => ref.current?.applyPlainSuggestion('hello')}>
                Insert suggestion
            </button>
            <RichComposerInput
                ref={ref}
                value={value}
                placeholder="Type a message"
                onValueChange={setValue}
                onMirrorChange={() => {}}
            />
        </>
    )
}

function MentionHarness() {
    const [value, setValue] = useState('')
    const ref = useRef<RichComposerInputHandle>(null)

    return (
        <>
            <button
                type="button"
                onClick={() =>
                    ref.current?.insertSessionMention({ id: 'sid-1', title: '아주 긴 데모 세션 이름 예시 말줄임표 필요' })
                }
            >
                Insert mention
            </button>
            <RichComposerInput ref={ref} value={value} onValueChange={setValue} onMirrorChange={() => {}} />
        </>
    )
}

function LineBreakDeletionHarness() {
    const [value, setValue] = useState('hello')

    return (
        <>
            <output data-testid="controlled-value">{value}</output>
            <RichComposerInput
                value={value}
                onValueChange={(next) => {
                    flushSync(() => setValue(next))
                }}
                onMirrorChange={() => {}}
            />
        </>
    )
}

describe('RichComposerInput session mention pill', () => {
    it('renders the mention pill with working text ellipsis clipping', () => {
        render(<MentionHarness />)

        fireEvent.click(screen.getByRole('button', { name: 'Insert mention' }))

        const pill = screen.getByText('@아주 긴 데모 세션 이름 예시 말줄임표 필요')
        // Ellipsis lives on the inner label; the pill itself centers it vertically.
        expect(pill.className).toContain('truncate')
        expect(pill.parentElement?.dataset.composerMention).toBe('session')
        expect(pill.parentElement?.className).toContain('inline-flex')
        expect(pill.parentElement?.className).toContain('align-baseline')
        expect(pill.parentElement?.className).not.toContain('overflow-hidden')
    })
})

describe('RichComposerInput responsive placeholder', () => {
    it('calculates a smaller font that fits overflowing text', () => {
        expect(fitSingleLineFontSize(160, 320)).toBeCloseTo(7.95)
        expect(fitSingleLineFontSize(320, 320)).toBe(16)
        expect(fitSingleLineFontSize(640, 320)).toBe(16)
        expect(fitSingleLineFontSize(0, 320)).toBe(16)
        expect(fitSingleLineFontSize(Number.NaN, 320)).toBe(16)
        expect(fitSingleLineFontSize(384, 320, 19.2)).toBe(19.2)
        expect(fitSingleLineFontSize(160, 320, 19.2)).toBeCloseTo(9.54)
    })

    it('refits the complete single-line placeholder when its container width changes', () => {
        let resizeCallback: ResizeObserverCallback | undefined
        class TestResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallback = callback
            }
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', TestResizeObserver)
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            fontSize: '19.2px',
        } as CSSStyleDeclaration)

        try {
            render(
                <RichComposerInput
                    value=""
                    placeholder="Type what you want the agent to do, without truncation"
                    onValueChange={() => {}}
                    onMirrorChange={() => {}}
                />
            )

            const placeholder = screen.getByTestId('rich-composer-placeholder')
            let availableWidth = 160
            Object.defineProperty(placeholder, 'clientWidth', {
                configurable: true,
                get: () => availableWidth,
            })
            Object.defineProperty(placeholder, 'scrollWidth', {
                configurable: true,
                get: () => 320,
            })

            resizeCallback?.([], {} as ResizeObserver)
            expect(placeholder).toHaveTextContent('Type what you want the agent to do, without truncation')
            expect(placeholder).not.toHaveClass('text-ellipsis')
            expect(placeholder).toHaveClass('text-base')
            expect(placeholder.style.fontSize).toBe('9.54px')

            availableWidth = 640
            resizeCallback?.([], {} as ResizeObserver)
            expect(placeholder.style.fontSize).toBe('19.2px')
        } finally {
            vi.restoreAllMocks()
            vi.unstubAllGlobals()
        }
    })
})

describe('RichComposerInput controlled synchronization', () => {
    afterEach(() => {
        window.getSelection()?.removeAllRanges()
    })

    it('preserves a middle-caret DOM input through its synchronous controlled echo and accepts later external replacement', () => {
        render(<SynchronousControlledHarness />)

        const editor = screen.getByTestId('rich-composer-input')
        const originalText = editor.firstChild
        expect(originalText).toBeInstanceOf(Text)

        const textNode = originalText as Text
        placeCaret(textNode, 2)
        textNode.textContent = 'alXpha'
        placeCaret(textNode, 3)
        fireEvent.input(editor)

        // The same-tick controlled acknowledgement and mirror-triggered parent
        // render must retain the browser-mutated DOM and logical caret.
        expect(screen.getByTestId('controlled-value')).toHaveTextContent('alXpha')
        expect(editor.firstChild).toBe(originalText)
        expect(serializeComposerSegments(segmentsFromEditor(editor))).toBe('alXpha')
        expect(selectionOffset(editor)).toBe(3)

        editor.focus()
        expect(document.activeElement).toBe(editor)
        fireEvent.click(screen.getByRole('button', { name: 'Replace draft' }))

        expect(serializeComposerSegments(segmentsFromEditor(editor))).toBe('external draft')
        expect(selectionOffset(editor)).toBe('external draft'.length)
    })

    it('tracks placeholder visibility from the DOM during composition', () => {
        render(
            <RichComposerInput
                value=""
                placeholder="Type a message"
                onValueChange={() => {}}
                onMirrorChange={() => {}}
            />
        )

        const editor = screen.getByTestId('rich-composer-input')
        expect(screen.getByText('Type a message')).toBeInTheDocument()

        fireEvent.compositionStart(editor)
        editor.textContent = 'dictated text'
        fireEvent.input(editor)
        expect(screen.queryByText('Type a message')).not.toBeInTheDocument()

        editor.replaceChildren(document.createElement('br'))
        fireEvent.input(editor)
        expect(screen.getByText('Type a message')).toBeInTheDocument()
    })

    it('tracks placeholder visibility for programmatic insertion and deletion', () => {
        render(<ProgrammaticEditHarness />)

        const editor = screen.getByTestId('rich-composer-input')
        expect(screen.getByText('Type a message')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Insert suggestion' }))
        expect(screen.queryByText('Type a message')).not.toBeInTheDocument()

        const text = editor.firstChild
        expect(text).toBeInstanceOf(Text)
        const range = document.createRange()
        range.selectNodeContents(editor)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        fireEvent.keyDown(editor, { key: 'Backspace' })

        expect(screen.getByText('Type a message')).toBeInTheDocument()
    })

    it('deletes exactly one trailing line break per Backspace', () => {
        render(<LineBreakDeletionHarness />)

        const editor = screen.getByTestId('rich-composer-input')
        const text = editor.firstChild
        expect(text).toBeInstanceOf(Text)
        editor.focus()
        placeCaret(text as Text, text?.textContent?.length ?? 0)

        fireEvent.keyDown(editor, { key: 'Enter' })
        expect(screen.getByTestId('controlled-value').textContent).toBe('hello\n')

        fireEvent.keyDown(editor, { key: 'Enter' })
        expect(screen.getByTestId('controlled-value').textContent).toBe('hello\n\n')

        fireEvent.keyDown(editor, { key: 'Backspace' })
        expect(screen.getByTestId('controlled-value').textContent).toBe('hello\n')

        fireEvent.keyDown(editor, { key: 'Backspace' })
        expect(screen.getByTestId('controlled-value').textContent).toBe('hello')
        expect(selectionOffset(editor)).toBe('hello'.length)
    })

    it('handles soft-keyboard backward deletion through beforeinput', () => {
        render(<LineBreakDeletionHarness />)

        const editor = screen.getByTestId('rich-composer-input')
        const text = editor.firstChild
        expect(text).toBeInstanceOf(Text)
        editor.focus()
        placeCaret(text as Text, text?.textContent?.length ?? 0)
        fireEvent.keyDown(editor, { key: 'Enter' })

        const event = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'deleteContentBackward',
        })
        expect(editor.dispatchEvent(event)).toBe(false)
        expect(screen.getByTestId('controlled-value').textContent).toBe('hello')
        expect(selectionOffset(editor)).toBe('hello'.length)
    })

    it('leaves ordinary beforeinput deletion to the browser', () => {
        render(<LineBreakDeletionHarness />)

        const editor = screen.getByTestId('rich-composer-input')
        const text = editor.firstChild
        expect(text).toBeInstanceOf(Text)
        editor.focus()
        placeCaret(text as Text, text?.textContent?.length ?? 0)

        const event = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'deleteContentBackward',
        })
        expect(editor.dispatchEvent(event)).toBe(true)
        expect(event.defaultPrevented).toBe(false)
    })

    it('does not forward Enter while composition is active', () => {
        const onKeyDown = vi.fn()
        render(
            <RichComposerInput
                value="hello"
                onValueChange={() => {}}
                onMirrorChange={() => {}}
                onKeyDown={onKeyDown}
            />
        )

        const editor = screen.getByTestId('rich-composer-input')
        fireEvent.compositionStart(editor)
        fireEvent.keyDown(editor, { key: 'Enter', isComposing: false })

        expect(onKeyDown).not.toHaveBeenCalled()
        expect(serializeComposerSegments(segmentsFromEditor(editor))).toBe('hello')
    })
})

describe('RichComposerInput paste', () => {
    it('forwards pasted non-image files to onPaste', () => {
        const onPaste = vi.fn()
        render(
            <RichComposerInput
                value=""
                onValueChange={() => {}}
                onMirrorChange={() => {}}
                onPaste={onPaste}
            />
        )

        const file = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })
        fireEvent.paste(screen.getByTestId('rich-composer-input'), {
            clipboardData: { files: [file], getData: () => '' },
        })

        expect(onPaste).toHaveBeenCalledTimes(1)
    })

    it('inserts plain text without calling onPaste when no files are pasted', () => {
        const onPaste = vi.fn()
        const onValueChange = vi.fn()
        render(
            <RichComposerInput
                value=""
                onValueChange={onValueChange}
                onMirrorChange={() => {}}
                onPaste={onPaste}
            />
        )

        fireEvent.paste(screen.getByTestId('rich-composer-input'), {
            clipboardData: { files: [], getData: () => 'pasted text' },
        })

        expect(onPaste).not.toHaveBeenCalled()
        expect(onValueChange).toHaveBeenLastCalledWith('pasted text')
    })
})

function UndoHarness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial)

    return (
        <>
            <output data-testid="controlled-value">{value}</output>
            <RichComposerInput
                value={value}
                onValueChange={(next) => {
                    flushSync(() => setValue(next))
                }}
                onMirrorChange={() => {}}
            />
        </>
    )
}

describe('RichComposerInput undo history', () => {
    afterEach(() => {
        window.getSelection()?.removeAllRanges()
    })

    function currentSelection(root: HTMLElement): { start: number; end: number } {
        const range = window.getSelection()!.getRangeAt(0)
        return {
            start: mirrorOffsetFromPoint(root, range.startContainer, range.startOffset),
            end: mirrorOffsetFromPoint(root, range.endContainer, range.endOffset),
        }
    }

    it('undoes and redoes a plain-text paste', () => {
        render(<UndoHarness initial="original draft" />)
        const editor = screen.getByTestId('rich-composer-input')
        const value = screen.getByTestId('controlled-value')
        editor.focus()
        placeCaret(editor.firstChild as Text, 'original draft'.length)

        fireEvent.paste(editor, {
            clipboardData: { files: [], getData: () => ' pasted text' },
        })
        expect(value.textContent).toBe('original draft pasted text')

        fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
        expect(value.textContent).toBe('original draft')
        expect(currentSelection(editor)).toEqual({ start: 14, end: 14 })

        fireEvent.keyDown(editor, { key: 'Z', ctrlKey: true, shiftKey: true })
        expect(value.textContent).toBe('original draft pasted text')
        expect(currentSelection(editor)).toEqual({ start: 26, end: 26 })
    })

    it('restores text and selection deleted with Backspace', () => {
        render(<UndoHarness initial="original draft" />)
        const editor = screen.getByTestId('rich-composer-input')
        const value = screen.getByTestId('controlled-value')
        editor.focus()
        const range = document.createRange()
        range.selectNodeContents(editor)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)

        fireEvent.keyDown(editor, { key: 'Backspace' })
        expect(value.textContent).toBe('')

        fireEvent.keyDown(editor, { key: 'z', metaKey: true })
        expect(value.textContent).toBe('original draft')
        expect(currentSelection(editor)).toEqual({ start: 0, end: 14 })

        fireEvent.keyDown(editor, { key: 'y', ctrlKey: true })
        expect(value.textContent).toBe('')
    })

    it('restores literal session-link text without turning it into a mention', () => {
        const literal = '[two  spaces](/sessions/abc)'
        render(<UndoHarness initial="" />)
        const editor = screen.getByTestId('rich-composer-input')
        const value = screen.getByTestId('controlled-value')
        editor.focus()
        const text = editor.firstChild as Text
        text.textContent = literal
        placeCaret(text, literal.length)
        fireEvent.input(editor)
        expect(value.textContent).toBe(literal)

        const range = document.createRange()
        range.selectNodeContents(editor)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        fireEvent.keyDown(editor, { key: 'Backspace' })
        expect(value.textContent).toBe('')

        fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
        expect(value.textContent).toBe(literal)
        expect(editor.querySelector('[data-composer-mention]')).toBeNull()
        expect(currentSelection(editor)).toEqual({ start: 0, end: literal.length })
    })

    it('undoes a native typing run as one step and handles beforeinput historyUndo', () => {
        render(<UndoHarness initial="ab" />)
        const editor = screen.getByTestId('rich-composer-input')
        const value = screen.getByTestId('controlled-value')
        editor.focus()
        const text = editor.firstChild as Text

        for (const char of 'cd') {
            placeCaret(text, text.length)
            editor.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: char,
            }))
            text.appendData(char)
            placeCaret(text, text.length)
            fireEvent.input(editor)
        }
        expect(value.textContent).toBe('abcd')

        const undo = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'historyUndo',
        })
        expect(editor.dispatchEvent(undo)).toBe(false)
        expect(value.textContent).toBe('ab')
    })
})
