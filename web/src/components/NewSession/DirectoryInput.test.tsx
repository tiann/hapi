import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryInput } from './DirectoryInput'

function touch(input: HTMLElement, type: string, points: Array<[number, number]> = []) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) })
    input.dispatchEvent(event)
    return event
}

beforeEach(() => {
    vi.spyOn(HTMLInputElement.prototype, 'scrollWidth', 'get').mockReturnValue(900)
    vi.spyOn(HTMLInputElement.prototype, 'clientWidth', 'get').mockReturnValue(250)
})
afterEach(() => vi.restoreAllMocks())

describe('DirectoryInput', () => {
    it('reveals initial and externally replaced paths without focusing', () => {
        const { rerender } = render(<DirectoryInput value="/home/example/initial" onChange={() => {}} />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        expect(input.scrollLeft).toBe(900)
        expect(input).not.toHaveFocus()
        input.scrollLeft = 40
        rerender(<DirectoryInput value="/home/example/recent" onChange={() => {}} />)
        expect(input.scrollLeft).toBe(900)
        expect(input).toHaveValue('/home/example/recent')
    })

    it('preserves manual inspection and selection across unrelated rerenders', () => {
        const { rerender } = render(<DirectoryInput value="/home/example/project" onChange={() => {}} />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.scrollLeft = 45
        input.setSelectionRange(6, 13)
        rerender(<DirectoryInput value="/home/example/project" disabled onChange={() => {}} />)
        expect(input.scrollLeft).toBe(45)
        expect([input.selectionStart, input.selectionEnd]).toEqual([6, 13])
    })

    it('reveals a reselected path even when the value is unchanged', () => {
        const { rerender } = render(<DirectoryInput value="/home/example/project" revealTailKey={0} readOnly />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.scrollLeft = 20
        rerender(<DirectoryInput value="/home/example/project" revealTailKey={1} readOnly />)
        expect(input.scrollLeft).toBe(900)
        expect(input).not.toHaveFocus()
    })

    it('reveals the tail after blur, after the browser resets the input scroll', () => {
        let frame: FrameRequestCallback | undefined
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback
            return 1
        })
        const onBlur = vi.fn()
        render(<DirectoryInput value="/home/example/project" onBlur={onBlur} readOnly />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.focus()
        input.setSelectionRange(4, 7)
        input.scrollLeft = 20
        input.blur()
        expect(onBlur).toHaveBeenCalledOnce()
        // Android WebView can reset the scroll after dispatching blur.
        input.scrollLeft = 0
        expect(frame).toBeTypeOf('function')
        frame!(0)
        expect(input.scrollLeft).toBe(900)
        expect([input.selectionStart, input.selectionEnd]).toEqual([4, 7])
    })

    it.each(['refocus', 'touch', 'unmount'])('cancels pending blur scrolling on %s', scenario => {
        let frame: FrameRequestCallback | undefined
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback
            return 7
        })
        const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
        const { unmount } = render(<DirectoryInput value="/home/example/project" readOnly />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.focus()
        input.blur()
        expect(frame).toBeTypeOf('function')
        input.scrollLeft = 25
        if (scenario === 'refocus') input.focus()
        if (scenario === 'touch') touch(input, 'touchstart', [[30, 20]])
        if (scenario === 'unmount') unmount()
        expect(cancelFrame).toHaveBeenCalledWith(7)
        // Even a queued callback that raced with cancellation must be inert.
        frame!(0)
        expect(input.scrollLeft).toBe(25)
    })

    it('does not force the tail after local typing, including composition input', () => {
        const onChange = vi.fn()
        function ControlledInput() {
            const [value, setValue] = useState('/home/example/project')
            return <DirectoryInput value={value} onChange={event => {
                onChange(event)
                setValue(event.target.value)
            }} />
        }
        render(<ControlledInput />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.focus()
        input.scrollLeft = 20
        fireEvent.compositionStart(input)
        fireEvent.change(input, { target: { value: '/home/中文/project', selectionStart: 8, selectionEnd: 8 } })
        fireEvent.compositionEnd(input)
        expect(onChange).toHaveBeenCalledOnce()
        expect(input.scrollLeft).toBe(20)
        expect(input.selectionStart).toBe(8)
    })

    it('scrolls unfocused horizontal gestures and suppresses their synthetic clicks', () => {
        render(<DirectoryInput value="/home/example/project" readOnly />)
        const input = screen.getByRole('textbox') as HTMLInputElement
        input.scrollLeft = 400
        expect(touch(input, 'touchstart', [[30, 20]]).defaultPrevented).toBe(false)
        expect(touch(input, 'touchmove', [[130, 22]]).defaultPrevented).toBe(true)
        expect(input.scrollLeft).toBe(300)
        expect(touch(input, 'touchend').defaultPrevented).toBe(true)
        expect(input).not.toHaveFocus()
    })

    it.each(['tap', 'vertical', 'focused', 'disabled', 'short', 'multitouch', 'contextmenu', 'cancel']) (
        'leaves %s interactions to the browser', (scenario) => {
            if (scenario === 'short') vi.spyOn(HTMLInputElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
            render(<DirectoryInput value="/project" disabled={scenario === 'disabled'} readOnly />)
            const input = screen.getByRole('textbox') as HTMLInputElement
            input.scrollLeft = 40
            if (scenario === 'focused') {
                input.focus()
                input.setSelectionRange(1, 4)
            }
            touch(input, 'touchstart', [[30, 20]])
            if (scenario === 'contextmenu') fireEvent.contextMenu(input)
            if (scenario === 'cancel') touch(input, 'touchcancel')
            const points: Array<[number, number]> = scenario === 'multitouch'
                ? [[130, 20], [160, 20]]
                : scenario === 'vertical' ? [[32, 120]]
                : scenario === 'tap' ? [[32, 21]] : [[130, 20]]
            expect(touch(input, 'touchmove', points).defaultPrevented).toBe(false)
            expect(touch(input, 'touchend').defaultPrevented).toBe(false)
            expect(input.scrollLeft).toBe(40)
            if (scenario === 'focused') expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
        }
    )
})
