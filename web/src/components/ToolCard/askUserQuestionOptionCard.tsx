import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

export type AskUserQuestionChoiceMode = 'single' | 'multi'

// Tightens the markdown block elements so a Markdown-rendered option row keeps
// the same compact spacing and inherited colors as the plain-text rows.
const askUserQuestionOptionMarkdownClassName = '[&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6'

export const askUserQuestionOptionTitleClassName = 'tracking-tight min-w-0 text-sm font-medium leading-tight break-words text-[var(--app-fg)]'
export const askUserQuestionOptionDescriptionClassName = 'mt-1 font-mono text-xs break-all text-[var(--app-tool-card-subtitle)]'
export const askUserQuestionQuoteClassName = 'tool-result-quote rounded-r-2xl border-l-[3px] border-[var(--app-md-quote-border)] bg-[var(--app-md-quote-bg)] px-4 py-3 text-sm leading-6 text-[var(--app-md-quote-fg)] [&_.aui-md]:text-inherit [&_.aui-md]:text-sm [&_.aui-md]:leading-6 [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6 [&_.aui-md-strong]:text-inherit'

export function getAskUserQuestionOptionFrameClassName(checked: boolean, className?: string): string {
    return cn(
        className,
        'rounded-[22px] border-[1.5px] p-[2px]',
        checked
            ? 'border-[var(--app-md-quote-border)]'
            : 'border-transparent'
    )
}

export function AskUserQuestionOptionRow(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
    disabled: boolean
    title: string
    description?: string | null
    onClick: () => void
    markdown?: boolean
}) {
    return (
        <button
            type="button"
            role={props.mode === 'multi' ? 'checkbox' : 'radio'}
            aria-checked={props.checked}
            className={getAskUserQuestionOptionFrameClassName(
                props.checked,
                'w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50'
            )}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <AskUserQuestionOptionBody
                checked={props.checked}
                mode={props.mode}
                title={props.title}
                description={props.description}
                interactive
                markdown={props.markdown}
            />
        </button>
    )
}

export const askUserQuestionNavButtonClassName = 'h-8 rounded-full border-[var(--app-border)] bg-[var(--app-tool-card-bg)] px-3.5 text-[var(--app-fg)] hover:border-[var(--app-md-quote-border)] hover:bg-[var(--app-subtle-bg)]'

export function AskUserQuestionSelectionControl(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
}) {
    if (props.mode === 'multi') {
        return (
            <span
                className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    props.checked
                        ? 'border-[var(--app-tool-card-accent)] bg-[var(--app-tool-card-accent)]'
                        : 'border-[var(--app-border)] bg-[var(--app-bg)]'
                )}
                aria-hidden="true"
            >
                {props.checked ? (
                    <svg className="h-3 w-3 text-[var(--app-bg)]" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M3.5 8.2l2.8 2.8 6.2-6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                ) : null}
            </span>
        )
    }

    return (
        <span
            className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                props.checked
                    ? 'border-[var(--app-tool-card-accent)]'
                    : 'border-[var(--app-border)] bg-[var(--app-bg)]'
            )}
            aria-hidden="true"
        >
            {props.checked ? (
                <span className="h-2 w-2 rounded-full bg-[var(--app-tool-card-accent)]" />
            ) : null}
        </span>
    )
}

export function AskUserQuestionOptionBody(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
    title: string
    description?: string | null
    customLabel?: string | null
    interactive?: boolean
    showControl?: boolean
    markdown?: boolean
}) {
    const showControl = props.showControl ?? true

    return (
        <span
            className={cn(
                'flex items-center gap-3 rounded-[20px] bg-[var(--app-tool-card-bg)] px-3 py-2',
                props.checked ? null : 'opacity-70',
                props.interactive && !props.checked ? 'hover:opacity-100' : null
            )}
        >
            {showControl ? (
                <AskUserQuestionSelectionControl checked={props.checked} mode={props.mode} />
            ) : null}
            <span className="min-w-0 flex-1">
                <span className={cn(
                    'block',
                    askUserQuestionOptionTitleClassName,
                    props.markdown ? askUserQuestionOptionMarkdownClassName : null,
                    props.checked
                        ? 'text-[var(--app-fg)]'
                        : 'text-[var(--app-tool-card-subtitle)]'
                )}>
                    {props.markdown ? <MarkdownRenderer content={props.title} /> : props.title}
                </span>
                {props.description ? (
                    <span className={cn('block', askUserQuestionOptionDescriptionClassName, props.markdown ? askUserQuestionOptionMarkdownClassName : null)}>
                        {props.markdown ? <MarkdownRenderer content={props.description} /> : props.description}
                    </span>
                ) : null}
                {props.customLabel ? (
                    <span className={cn('block', askUserQuestionOptionDescriptionClassName)}>
                        {props.customLabel}
                    </span>
                ) : null}
            </span>
        </span>
    )
}
