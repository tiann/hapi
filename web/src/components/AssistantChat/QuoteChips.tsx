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
                <button
                    key={quote.id}
                    type="button"
                    data-testid="quote-chip"
                    title={t('quote.jumpToSource')}
                    onClick={() => props.onJump(quote)}
                    onMouseEnter={() => props.onHover?.(quote.id)}
                    onMouseLeave={() => props.onHover?.(null)}
                    className={`group relative flex items-center gap-2 overflow-hidden rounded-[7px] bg-[var(--app-md-quote-bg)] py-[5px] pl-[11px] pr-[6px] text-left text-[12.5px] transition-shadow hover:shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)] ${
                        props.activeQuoteId === quote.id ? 'shadow-[0_0_0_1px_var(--app-chat-user-chip-fg)]' : ''
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 w-[2.5px] bg-[var(--app-chat-user-chip-fg)] opacity-85"
                    />
                    {/* 序号只在 ≥2 条时显示，与序列化规则保持一致 */}
                    {props.quotes.length > 1 ? (
                        <span className="shrink-0 text-center font-mono text-[10px] font-bold leading-none text-[var(--app-chat-user-chip-fg)]">
                            {index + 1}
                        </span>
                    ) : null}
                    <span className="max-w-[158px] truncate text-[var(--app-md-quote-fg)]">
                        {quote.text.replace(/\s+/g, ' ')}
                    </span>
                    <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('quote.remove')}
                        title={t('quote.remove')}
                        data-testid="quote-chip-remove"
                        onClick={(event) => { event.stopPropagation(); props.onRemove(quote.id) }}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return
                            event.preventDefault(); event.stopPropagation(); props.onRemove(quote.id)
                        }}
                        className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-[5px] text-[var(--app-md-quote-fg)] opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100"
                    >
                        <RemoveIcon />
                    </span>
                </button>
            ))}
        </div>
    )
}
