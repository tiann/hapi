import { useCallback, useEffect, useState, type PointerEvent } from 'react'

const STORAGE_KEY = 'hapi-editor-pane-sizes'

const LEFT_DEFAULT = 260
const LEFT_MIN = 200
const LEFT_MAX = 500

const RIGHT_DEFAULT = 380
const RIGHT_MIN = 300
const RIGHT_MAX = 640

const TERMINAL_DEFAULT = 160
const TERMINAL_MIN = 100
const TERMINAL_MAX = 360

type PaneSizes = {
    leftWidth: number
    rightWidth: number
    terminalHeight: number
}

type DragState = {
    pane: 'left' | 'right' | 'terminal'
    pointerId: number
    startX: number
    startY: number
    startSize: number
    cursor: 'col-resize' | 'row-resize'
}

export type UseEditorPaneResizeResult = {
    leftWidth: number
    rightWidth: number
    terminalHeight: number
    isDragging: boolean
    onLeftResizePointerDown: (event: PointerEvent) => void
    onRightResizePointerDown: (event: PointerEvent) => void
    onTerminalResizePointerDown: (event: PointerEvent) => void
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? clamp(value, min, max)
        : fallback
}

function getDefaultSizes(): PaneSizes {
    return {
        leftWidth: LEFT_DEFAULT,
        rightWidth: RIGHT_DEFAULT,
        terminalHeight: TERMINAL_DEFAULT,
    }
}

function loadSizes(): PaneSizes {
    const defaults = getDefaultSizes()

    try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (!stored) return defaults

        const parsed: unknown = JSON.parse(stored)
        if (!parsed || typeof parsed !== 'object') return defaults

        const value = parsed as Partial<Record<keyof PaneSizes, unknown>>
        return {
            leftWidth: readNumber(value.leftWidth, defaults.leftWidth, LEFT_MIN, LEFT_MAX),
            rightWidth: readNumber(value.rightWidth, defaults.rightWidth, RIGHT_MIN, RIGHT_MAX),
            terminalHeight: readNumber(value.terminalHeight, defaults.terminalHeight, TERMINAL_MIN, TERMINAL_MAX),
        }
    } catch {
        return defaults
    }
}

function persistSizes(sizes: PaneSizes) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
}

export function useEditorPaneResize(): UseEditorPaneResizeResult {
    const [sizes, setSizes] = useState<PaneSizes>(loadSizes)
    const [drag, setDrag] = useState<DragState | null>(null)

    const onLeftResizePointerDown = useCallback((event: PointerEvent) => {
        event.preventDefault()
        setDrag({
            pane: 'left',
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startSize: sizes.leftWidth,
            cursor: 'col-resize',
        })
    }, [sizes.leftWidth])

    const onRightResizePointerDown = useCallback((event: PointerEvent) => {
        event.preventDefault()
        setDrag({
            pane: 'right',
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startSize: sizes.rightWidth,
            cursor: 'col-resize',
        })
    }, [sizes.rightWidth])

    const onTerminalResizePointerDown = useCallback((event: PointerEvent) => {
        event.preventDefault()
        setDrag({
            pane: 'terminal',
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startSize: sizes.terminalHeight,
            cursor: 'row-resize',
        })
    }, [sizes.terminalHeight])

    useEffect(() => {
        persistSizes(sizes)
    }, [sizes])

    useEffect(() => {
        if (!drag) return

        const previousUserSelect = document.body.style.userSelect
        const previousCursor = document.body.style.cursor

        document.body.style.userSelect = 'none'
        document.body.style.cursor = drag.cursor

        const onPointerMove = (event: globalThis.PointerEvent) => {
            if (event.pointerId !== drag.pointerId) return

            setSizes((current) => {
                if (drag.pane === 'left') {
                    const deltaX = event.clientX - drag.startX
                    return {
                        ...current,
                        leftWidth: clamp(drag.startSize + deltaX, LEFT_MIN, LEFT_MAX),
                    }
                }

                if (drag.pane === 'right') {
                    const deltaX = event.clientX - drag.startX
                    return {
                        ...current,
                        rightWidth: clamp(drag.startSize - deltaX, RIGHT_MIN, RIGHT_MAX),
                    }
                }

                const deltaY = event.clientY - drag.startY
                return {
                    ...current,
                    terminalHeight: clamp(drag.startSize - deltaY, TERMINAL_MIN, TERMINAL_MAX),
                }
            })
        }

        const onPointerEnd = (event: globalThis.PointerEvent) => {
            if (event.pointerId !== drag.pointerId) return
            setDrag(null)
        }

        document.addEventListener('pointermove', onPointerMove)
        document.addEventListener('pointerup', onPointerEnd)
        document.addEventListener('pointercancel', onPointerEnd)

        return () => {
            document.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerup', onPointerEnd)
            document.removeEventListener('pointercancel', onPointerEnd)
            document.body.style.userSelect = previousUserSelect
            document.body.style.cursor = previousCursor
        }
    }, [drag])

    return {
        leftWidth: sizes.leftWidth,
        rightWidth: sizes.rightWidth,
        terminalHeight: sizes.terminalHeight,
        isDragging: drag !== null,
        onLeftResizePointerDown,
        onRightResizePointerDown,
        onTerminalResizePointerDown,
    }
}
