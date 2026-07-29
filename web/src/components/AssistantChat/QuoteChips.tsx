import { useTranslation } from '@/lib/use-translation'
import type { Quote } from '@/lib/quotes'

function RemoveIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
    )
}

export function QuoteChips(props: {
    quotes: readonly Quote[]
    onRemove: (id: string) => void
    onJump: (quote: Quote) => void
    activeQuoteId?: string | null
    onHover?: (id: string | null) => void
}) {
    const { t } = useTranslation()
    if (props.quotes.length === 0) return null

    return (
        <div className="flex flex-wrap gap-[6px] px-4 pt-3" data-testid="quote-chips">
            {props.quotes.map((quote, index) => (
                // 外层是 div 而不是 button：跳转和移除是两个并列的操作，
                // 嵌套可交互控件会让键盘和辅助技术无法区分该激活哪一个。
                <div
                    key={quote.id}
                    data-testid="quote-chip"
                    onMouseEnter={() => props.onHover?.(quote.id)}
                    onMouseLeave={() => props.onHover?.(null)}
                    className={`group relative flex items-center overflow-hidden rounded-[7px] bg-[var(--app-md-quote-bg)] text-[12.5px] transition-shadow focus-within:shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)] hover:shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)] ${
                        props.activeQuoteId === quote.id ? 'shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)]' : ''
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 w-[2.5px] bg-[var(--app-chat-user-chip-fg)] opacity-85"
                    />
                    <button
                        type="button"
                        data-testid="quote-chip-jump"
                        title={t('quote.jumpToSource')}
                        onClick={() => props.onJump(quote)}
                        className="flex items-center gap-2 py-[5px] pl-[11px] pr-1 text-left outline-none"
                    >
                        {/* 序号只在 ≥2 条时显示，与序列化规则保持一致 */}
                        {props.quotes.length > 1 ? (
                            <span className="shrink-0 text-center font-mono text-[10px] font-bold leading-none text-[var(--app-chat-user-chip-fg)]">
                                {index + 1}
                            </span>
                        ) : null}
                        <span className="max-w-[158px] truncate text-[var(--app-md-quote-fg)]">
                            {quote.text.replace(/\s+/g, ' ')}
                        </span>
                    </button>
                    <button
                        type="button"
                        aria-label={t('quote.remove')}
                        title={t('quote.remove')}
                        data-testid="quote-chip-remove"
                        onClick={() => props.onRemove(quote.id)}
                        className="mr-[6px] grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-[var(--app-md-quote-fg)] opacity-0 outline-none transition-opacity focus-visible:opacity-100 group-hover:opacity-60 hover:!opacity-100"
                    >
                        <RemoveIcon />
                    </button>
                </div>
            ))}
        </div>
    )
}
