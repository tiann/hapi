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
