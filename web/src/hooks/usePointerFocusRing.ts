import { useCallback, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'

export function usePointerFocusRing() {
    const [suppressFocusRing, setSuppressFocusRing] = useState(false)

    const onTriggerPointerDown = useCallback((_event: PointerEvent<HTMLElement>) => {
        setSuppressFocusRing(true)
    }, [])

    const onTriggerKeyDown = useCallback((_event: KeyboardEvent<HTMLElement>) => {
        setSuppressFocusRing(false)
    }, [])

    const onTriggerBlur = useCallback((_event: FocusEvent<HTMLElement>) => {
        setSuppressFocusRing(false)
    }, [])

    return {
        suppressFocusRing,
        onTriggerPointerDown,
        onTriggerKeyDown,
        onTriggerBlur
    }
}
