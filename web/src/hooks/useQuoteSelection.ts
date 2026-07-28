import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlatform } from '@/hooks/usePlatform'

export type QuotableSelection = {
    text: string
    /** 视口坐标，用于给气泡定位 */
    rect: DOMRect
    /** 来源消息的 anchor id */
    messageId: string
    range: Range
}

const SELECTION_DEBOUNCE_MS = 110

function closestElement(node: Node | null): Element | null {
    if (!node) return null
    return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
}

/**
 * 判定当前选区是否可引用，并解析出引用所需的纯数据。
 *
 * 与 React 无关，单独导出以便直接单测。
 */
export function resolveQuotableSelection(
    selection: Selection | null,
    container: HTMLElement | null
): QuotableSelection | null {
    if (!selection || !container) return null
    if (selection.isCollapsed || selection.rangeCount === 0) return null

    const text = selection.toString().trim()
    if (!text) return null

    const range = selection.getRangeAt(0)
    let message = closestElement(range.commonAncestorContainer)?.closest('.happy-message') ?? null
    if (!message) {
        // 跨消息选区的 commonAncestorContainer 会落在两条消息的公共祖先上，
        // 此时归属到选区起点所在的那条消息。
        message = closestElement(selection.anchorNode)?.closest('.happy-message') ?? null
    }
    if (!message || !container.contains(message) || !message.id) return null

    return { text, rect: range.getBoundingClientRect(), messageId: message.id, range }
}

/**
 * 监听选区变化，产出当前可引用的选区（没有则为 null）。
 *
 * 触摸设备直接不挂监听（而非挂载后再判断）：原生选择手柄与自定义气泡
 * 会互相打架，本期范围仅桌面端。
 */
export function useQuoteSelection(containerRef: React.RefObject<HTMLElement | null>) {
    const [selection, setSelection] = useState<QuotableSelection | null>(null)
    const { isTouch } = usePlatform()
    const timerRef = useRef<number | null>(null)

    const refresh = useCallback(() => {
        setSelection(resolveQuotableSelection(window.getSelection(), containerRef.current))
    }, [containerRef])

    const clear = useCallback(() => {
        window.getSelection()?.removeAllRanges()
        setSelection(null)
    }, [])

    useEffect(() => {
        if (isTouch) return
        const onSelectionChange = () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            timerRef.current = window.setTimeout(refresh, SELECTION_DEBOUNCE_MS)
        }
        // mouseup 单独挂一次：拖拽结束时 selectionchange 可能早于最终 range 落定
        const onMouseUp = () => window.setTimeout(refresh, 0)
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('mouseup', onMouseUp)
        return () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
            document.removeEventListener('selectionchange', onSelectionChange)
            document.removeEventListener('mouseup', onMouseUp)
        }
    }, [isTouch, refresh])

    return { selection, refresh, clear, enabled: !isTouch }
}
