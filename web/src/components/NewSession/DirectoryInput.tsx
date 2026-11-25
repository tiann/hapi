import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react'

type Gesture = {
    x: number
    y: number
    scrollLeft: number
    dragging: boolean
}

export function DirectoryInput({ revealTailKey, ...props }: Omit<ComponentProps<'input'>, 'ref'> & {
    value: string
    revealTailKey?: number
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    const editedValue = useRef<string | null>(null)
    const previousTailKey = useRef(revealTailKey)
    const blurFrame = useRef<number | null>(null)

    function cancelBlurScroll() {
        if (blurFrame.current !== null) {
            cancelAnimationFrame(blurFrame.current)
            blurFrame.current = null
        }
    }

    useLayoutEffect(() => {
        // Only external replacements (initial value, Browse, recent paths,
        // autocomplete) reveal the tail. Typing must keep the native caret.
        if (props.value !== editedValue.current || revealTailKey !== previousTailKey.current) {
            const input = inputRef.current
            if (input) input.scrollLeft = input.scrollWidth
        }
        editedValue.current = props.value
        previousTailKey.current = revealTailKey
    }, [props.value, revealTailKey])

    useEffect(() => {
        const input = inputRef.current
        if (!input) return
        let gesture: Gesture | null = null

        const cancel = () => { gesture = null }
        const start = (event: TouchEvent) => {
            gesture = null
            cancelBlurScroll()
            // Focused inputs retain native caret dragging and text selection.
            if (input.disabled || document.activeElement === input || event.touches.length !== 1) return
            const touch = event.touches[0]!
            gesture = { x: touch.clientX, y: touch.clientY, scrollLeft: input.scrollLeft, dragging: false }
        }
        const move = (event: TouchEvent) => {
            if (!gesture) return
            if (input.disabled || event.touches.length !== 1 || document.activeElement === input) {
                cancel()
                return
            }
            const touch = event.touches[0]!
            const dx = touch.clientX - gesture.x
            const dy = touch.clientY - gesture.y
            if (!gesture.dragging) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
                if (Math.abs(dy) >= Math.abs(dx) || input.scrollWidth <= input.clientWidth) {
                    cancel()
                    return
                }
                gesture.dragging = true
            }
            if (event.cancelable) {
                event.preventDefault()
                input.scrollLeft = gesture.scrollLeft - dx
            }
        }
        const end = (event: TouchEvent) => {
            // A swipe inspects the path; a tap still opens the native editor.
            if (gesture?.dragging && event.cancelable) event.preventDefault()
            cancel()
        }

        input.addEventListener('touchstart', start, { passive: true })
        // React delegates touchmove passively. The local non-passive listener
        // cancels only horizontal inspection, leaving vertical page scroll,
        // taps, long presses and focused editing to the browser.
        input.addEventListener('touchmove', move, { passive: false })
        input.addEventListener('touchend', end, { passive: false })
        input.addEventListener('touchcancel', cancel)
        input.addEventListener('contextmenu', cancel)
        return () => {
            cancelBlurScroll()
            input.removeEventListener('touchstart', start)
            input.removeEventListener('touchmove', move)
            input.removeEventListener('touchend', end)
            input.removeEventListener('touchcancel', cancel)
            input.removeEventListener('contextmenu', cancel)
        }
    }, [])

    return <input
        {...props}
        ref={inputRef}
        onChange={(event) => {
            editedValue.current = event.target.value
            props.onChange?.(event)
        }}
        onFocus={(event) => {
            cancelBlurScroll()
            props.onFocus?.(event)
        }}
        onBlur={(event) => {
            cancelBlurScroll()
            props.onBlur?.(event)
            // WebView can reset the input scroll after blur dispatch. Reveal
            // the tail on the next frame without moving the caret or selection.
            const frame = requestAnimationFrame(() => {
                if (blurFrame.current !== frame) return
                blurFrame.current = null
                const input = inputRef.current
                if (input && document.activeElement !== input) {
                    input.scrollLeft = input.scrollWidth
                }
            })
            blurFrame.current = frame
        }}
    />
}
