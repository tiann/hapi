import { fireEvent, render, screen } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
    mirrorOffsetFromPoint,
    RichComposerInput,
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
})
