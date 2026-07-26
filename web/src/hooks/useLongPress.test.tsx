import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

function LongPressButton(props: { onClick: () => void; onLongPress: () => void }) {
    const handlers = useLongPress({
        onClick: props.onClick,
        onLongPress: props.onLongPress,
    })

    return <button type="button" {...handlers}>Session</button>
}

describe('useLongPress', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('uses the native click event for a regular activation', () => {
        const onClick = vi.fn()
        render(<LongPressButton onClick={onClick} onLongPress={vi.fn()} />)

        fireEvent.click(screen.getByRole('button', { name: 'Session' }))

        expect(onClick).toHaveBeenCalledOnce()
    })

    it('suppresses the click emitted after a long press', () => {
        const onClick = vi.fn()
        const onLongPress = vi.fn()
        render(<LongPressButton onClick={onClick} onLongPress={onLongPress} />)
        const button = screen.getByRole('button', { name: 'Session' })

        fireEvent.mouseDown(button, { button: 0, clientX: 10, clientY: 20 })
        vi.advanceTimersByTime(500)
        fireEvent.mouseUp(button, { button: 0 })
        fireEvent.click(button)

        expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 })
        expect(onClick).not.toHaveBeenCalled()
    })

    it('cancels the pending long press when release lands on another element', () => {
        const onLongPress = vi.fn()
        render(<LongPressButton onClick={vi.fn()} onLongPress={onLongPress} />)

        fireEvent.mouseDown(screen.getByRole('button', { name: 'Session' }), { button: 0 })
        fireEvent.mouseUp(document.body, { button: 0 })
        vi.advanceTimersByTime(500)

        expect(onLongPress).not.toHaveBeenCalled()
    })
})
