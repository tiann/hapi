import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import type { QuotableSelection } from '@/hooks/useQuoteSelection'

function QuoteIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-[18px] w-[18px]">
            <path d="M6.4 5C4.5 5 3 6.6 3 8.6c0 1.9 1.5 3.5 3.4 3.5.3 0 .6 0 .9-.1-.4 1.8-1.9 3.1-3.7 3.3V19c3.5-.2 6.2-3.2 6.2-6.8V8.6C9.8 6.6 8.3 5 6.4 5zm10.2 0c-1.9 0-3.4 1.6-3.4 3.6 0 1.9 1.5 3.5 3.4 3.5.3 0 .6 0 .9-.1-.4 1.8-1.9 3.1-3.7 3.3V19c3.5-.2 6.2-3.2 6.2-6.8V8.6C20 6.6 18.5 5 16.6 5z" />
        </svg>
    )
}

export function QuoteSelectionPopover(props: {
    selection: QuotableSelection | null
    onQuote: (selection: QuotableSelection) => void
}) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

    // 复制反馈一旦开始就不再因选区消失而收起：真人点完复制会移开鼠标或
    // 点别处，选区随即失效；若把反馈寿命绑在选区上，确认提示会瞬间消失。
    const open = Boolean(props.selection) || copied

    useEffect(() => {
        if (!props.selection) return
        const rect = props.selection.rect
        setPosition({ left: rect.left + rect.width / 2, top: rect.top })
    }, [props.selection])

    if (!open || !position) return null

    return (
        <Popover.Root open modal={false}>
            {/* 0×0 虚拟锚点：Radix 需要一个真实 DOM 节点来定位，这个 span
                跟随选区 rect，本身不可见也不占布局 */}
            <Popover.Anchor asChild>
                <span
                    aria-hidden="true"
                    style={{
                        position: 'fixed',
                        left: position.left,
                        top: position.top,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                    }}
                />
            </Popover.Anchor>
            <Popover.Portal>
                <Popover.Content
                    side="top"
                    sideOffset={8}
                    collisionPadding={8}
                    // 不加这两行功能直接失效：Radix 默认把焦点移进内容区，
                    // 焦点转移会清除文本选区，引用就拿不到内容了。
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    // 按钮抢焦点同样会清选区，在容器上一次性拦掉
                    onMouseDown={(event) => event.preventDefault()}
                    data-testid="quote-selection-popover"
                    className="z-50 flex items-center gap-px rounded-[11px] border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                >
                    <button
                        type="button"
                        title={t('quote.action')}
                        aria-label={t('quote.action')}
                        data-testid="quote-button"
                        onClick={() => { if (props.selection) props.onQuote(props.selection) }}
                        className="grid h-8 w-[34px] place-items-center rounded-lg text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-chat-user-chip-fg)]"
                    >
                        <QuoteIcon />
                    </button>
                    <span className="h-[17px] w-px shrink-0 bg-[var(--app-border)]" aria-hidden="true" />
                    <button
                        type="button"
                        title={copied ? t('message.copied') : t('quote.copySelection')}
                        aria-label={copied ? t('message.copied') : t('quote.copySelection')}
                        data-testid="quote-copy-button"
                        onClick={() => { if (props.selection) void copy(props.selection.text) }}
                        className={`flex h-8 items-center gap-[7px] rounded-lg transition-colors ${
                            copied
                                ? 'bg-green-500/[.13] px-[14px] text-green-500'
                                : 'w-[34px] justify-center text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-chat-user-chip-fg)]'
                        }`}
                    >
                        {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                        {copied ? <span className="text-[13px] font-semibold">{t('message.copied')}</span> : null}
                    </button>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
