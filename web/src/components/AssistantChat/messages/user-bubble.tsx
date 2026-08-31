import { useState } from 'react'
import type { MessageStatus } from '@/types/api'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { SparklesIcon } from '@/components/ToolCard/icons'
import { cn } from '@/lib/utils'
import { getCollapsedUserMessage } from '@/lib/textContext'

const LEADING_DIRECTIVE_REGEX = /^([$\/][a-z0-9][\w-]*)(?=\s|$)/i

export function getUserBubbleClassName(status?: MessageStatus) {
    return cn(
        'happy-user-bubble happy-chat-text ml-auto w-fit min-w-0 max-w-[92%] rounded-2xl bg-[var(--app-chat-user-surface-bg)] px-4 py-2.5 text-[var(--app-chat-user-fg)] shadow-none',
        status === 'queued' && 'opacity-60'
    )
}

export function shouldShowMessageStatus(status?: MessageStatus): boolean {
    return status === 'queued' || status === 'sending' || status === 'failed'
}

export function extractLeadingDirectives(text: string): { directives: string[]; body: string } {
    let rest = text.trimStart()
    const directives: string[] = []

    while (rest.length > 0) {
        const match = rest.match(LEADING_DIRECTIVE_REGEX)
        if (!match) break

        directives.push(match[1])
        rest = rest.slice(match[0].length).trimStart()
    }

    return {
        directives,
        body: rest,
    }
}

export function formatDirectiveLabel(value: string): string {
    return value
        .replace(/^[$/]/, '')
        .replace(/[_-]+/g, ' ')
        .trim()
}

export function DirectiveChip(props: { value: string }) {
    const label = formatDirectiveLabel(props.value)

    return (
        <span
            className={cn(
                'inline-flex items-center justify-center gap-[0.2rem] whitespace-nowrap rounded-full border-0 bg-[var(--app-chat-user-chip-bg)] px-2 py-px align-middle text-[length:var(--app-chat-font-size)] font-normal leading-[1.4] text-[var(--app-chat-user-chip-fg)] shadow-none'
            )}
            title={props.value}
            aria-label={props.value}
        >
            <SparklesIcon className="h-[0.92em] w-[0.92em] shrink-0 [stroke-width:1.6]" />
            <span>{label}</span>
        </span>
    )
}

export function UserBubbleContent(props: {
    text: string
    expandLabel?: string
    collapseLabel?: string
}) {
    const [expanded, setExpanded] = useState(false)
    const collapsed = getCollapsedUserMessage(props.text)
    const displayedText = collapsed.collapsible && !expanded
        ? collapsed.preview
        : props.text
    const { directives, body } = extractLeadingDirectives(displayedText)
    const hasBody = body.trim().length > 0
    const shouldRenderInline = directives.length > 0 && hasBody && !/[\r\n]/.test(body)

    const content = shouldRenderInline ? (
        <div className="happy-chat-text min-w-0">
            <div className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 align-top">
                {directives.map((directive) => <DirectiveChip key={directive} value={directive} />)}
                <LazyRainbowText text={body} inline preserveSingleLineBreaks />
            </div>
        </div>
    ) : (
        <div className="flex min-w-0 flex-col gap-2">
            {directives.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {directives.map((directive) => <DirectiveChip key={directive} value={directive} />)}
                </div>
            ) : null}
            {hasBody ? <LazyRainbowText text={body} preserveSingleLineBreaks /> : null}
        </div>
    )

    return (
        <div className="min-w-0">
            {content}
            {collapsed.collapsible ? (
                <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    className="mt-2 text-xs font-medium text-[var(--app-link)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-link)]"
                >
                    {expanded
                        ? props.collapseLabel ?? 'Collapse message'
                        : props.expandLabel ?? 'Expand full message'}
                </button>
            ) : null}
        </div>
    )
}
