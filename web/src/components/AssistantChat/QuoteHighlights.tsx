import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Quote } from '@/lib/quotes'

const HIGHLIGHT_NAME = 'hapi-quote'

type Marker = { id: string; index: number; left: number; top: number }

function supportsHighlightApi(): boolean {
    return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/**
 * 在原文里定位一条引用的 Range。
 *
 * 引用只存了文本不存 Range（Range 无法持久化，刷新即失效），所以要在来源
 * 消息里按文本重新查找。同一段文字在长消息中可能出现多次——取第一处，
 * 这是已知的近似。
 */
function findRange(messageId: string, text: string): Range | null {
    const host = document.getElementById(messageId)
    if (!host) return null
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let total = ''
    let node: Node | null
    while ((node = walker.nextNode())) {
        nodes.push(node as Text)
        total += node.nodeValue ?? ''
    }
    const start = total.indexOf(text)
    if (start < 0) return null
    const end = start + text.length

    const range = document.createRange()
    let consumed = 0
    let startSet = false
    for (const textNode of nodes) {
        const length = textNode.nodeValue?.length ?? 0
        if (!startSet && consumed + length > start) {
            range.setStart(textNode, start - consumed)
            startSet = true
        }
        if (startSet && consumed + length >= end) {
            range.setEnd(textNode, end - consumed)
            return range
        }
        consumed += length
    }
    return null
}

/**
 * 绘制被引用原文的底纹与角标。
 *
 * 降级：CSS.highlights 不可用时（Firefox < 140 等）只是不画高亮和角标，
 * 引用功能本身完全可用。这是有意的渐进增强，不是静默失败——降级路径在
 * dev 模式下会打一条 console.info。
 */
export function QuoteHighlights(props: {
    quotes: readonly Quote[]
    containerRef: React.RefObject<HTMLElement | null>
    activeQuoteId?: string | null
}) {
    const [markers, setMarkers] = useState<Marker[]>([])
    const warnedRef = useRef(false)

    const layout = useCallback(() => {
        const container = props.containerRef.current
        if (!container) return

        if (!supportsHighlightApi()) {
            if (import.meta.env.DEV && !warnedRef.current) {
                warnedRef.current = true
                console.info('[quote] CSS Custom Highlight API unavailable; quotes work, source highlighting is skipped')
            }
            setMarkers([])
            return
        }

        const containerRect = container.getBoundingClientRect()
        const ranges: Range[] = []
        const next: Marker[] = []

        props.quotes.forEach((quote, index) => {
            const range = findRange(quote.messageId, quote.text)
            if (!range) return
            ranges.push(range)
            const rects = range.getClientRects()
            const last = rects[rects.length - 1]
            if (!last) return
            next.push({
                id: quote.id,
                index,
                left: last.right - containerRect.left + 1,
                top: last.top - containerRect.top - 3,
            })
        })

        // 没有任何可高亮的 range 时移除注册项，而不是塞一个空 Highlight：
        // 空 Highlight 虽然不画任何东西，却会让 CSS.highlights 永远含有本键，
        // 「当前有没有高亮」就无从判断了。
        if (ranges.length === 0) {
            CSS.highlights.delete(HIGHLIGHT_NAME)
        } else {
            CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
        }
        setMarkers(next)
    }, [props.quotes, props.containerRef])

    useLayoutEffect(() => { layout() }, [layout])

    useEffect(() => {
        // 布局变化都要重算：窗口尺寸、消息区尺寸（流式输出会不断改变高度）
        window.addEventListener('resize', layout)
        const container = props.containerRef.current
        let observer: ResizeObserver | null = null
        if (container && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(layout)
            observer.observe(container)
        }
        return () => {
            window.removeEventListener('resize', layout)
            observer?.disconnect()
        }
    }, [layout, props.containerRef])

    useEffect(() => () => {
        if (supportsHighlightApi()) CSS.highlights.delete(HIGHLIGHT_NAME)
    }, [])

    // 只有 ≥2 条时才显示编号，与序列化和 chip 保持一致
    if (props.quotes.length < 2) return null

    return (
        <>
            {markers.map((marker) => (
                <span
                    key={marker.id}
                    data-testid="quote-marker"
                    aria-hidden="true"
                    style={{ position: 'absolute', left: marker.left, top: marker.top }}
                    className={`pointer-events-none z-[5] rounded-[4px] px-[3.5px] py-[2px] font-mono text-[9.5px] font-bold leading-none text-[var(--app-chat-user-chip-fg)] transition-colors ${
                        props.activeQuoteId === marker.id
                            ? 'bg-[var(--app-chat-user-chip-bg)] shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)]'
                            : 'bg-[var(--app-bg)] shadow-[0_0_0_1px_var(--app-chat-user-chip-bg)]'
                    }`}
                >
                    {marker.index + 1}
                </span>
            ))}
        </>
    )
}
