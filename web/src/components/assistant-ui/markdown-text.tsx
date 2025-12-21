import type { ComponentPropsWithoutRef } from 'react'
import { useState } from 'react'
import {
    MarkdownTextPrimitive,
    unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
    useIsMarkdownCodeBlock,
    type CodeHeaderProps,
} from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import { getPlatform } from '@/hooks/usePlatform'
import { cn } from '@/lib/utils'
import { SyntaxHighlighter } from '@/components/assistant-ui/shiki-highlighter'

export const MARKDOWN_PLUGINS = [remarkGfm]

function safeCopyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text)
    }
    return Promise.reject(new Error('Clipboard API not available'))
}

function CopyIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function CodeHeader(props: CodeHeaderProps) {
    const [copied, setCopied] = useState(false)

    const language = props.language && props.language !== 'unknown' ? props.language : ''

    const handleCopy = async () => {
        const { haptic } = getPlatform()
        try {
            await safeCopyToClipboard(props.code)
            haptic.notification('success')
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            haptic.notification('error')
        }
    }

    return (
        <div className="aui-md-codeheader flex items-center justify-between rounded-t-md bg-[var(--app-code-bg)] px-2 py-1">
            <div className="min-w-0 flex-1 pr-2 text-xs font-mono text-[var(--app-hint)]">
                {language}
            </div>
            <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                title="Copy"
            >
                {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
        </div>
    )
}

function Pre(props: ComponentPropsWithoutRef<'pre'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden">
            <pre
                {...rest}
                className={cn(
                    'aui-md-pre m-0 w-max min-w-full rounded-b-md rounded-t-none bg-[var(--app-code-bg)] p-2 text-xs',
                    className
                )}
            />
        </div>
    )
}

function Code(props: ComponentPropsWithoutRef<'code'>) {
    const isCodeBlock = useIsMarkdownCodeBlock()

    if (isCodeBlock) {
        return (
            <code
                {...props}
                className={cn('aui-md-codeblockcode font-mono', props.className)}
            />
        )
    }

    return (
        <code
            {...props}
            className={cn(
                'aui-md-code break-words rounded bg-[var(--app-inline-code-bg)] px-[0.3em] py-[0.1em] font-mono text-[0.9em]',
                props.className
            )}
        />
    )
}

function A(props: ComponentPropsWithoutRef<'a'>) {
    const rel = props.target === '_blank' ? (props.rel ?? 'noreferrer') : props.rel

    return (
        <a
            {...props}
            rel={rel}
            className={cn('aui-md-a text-[var(--app-link)] underline', props.className)}
        />
    )
}

function Paragraph(props: ComponentPropsWithoutRef<'p'>) {
    return <p {...props} className={cn('aui-md-p leading-relaxed', props.className)} />
}

function Blockquote(props: ComponentPropsWithoutRef<'blockquote'>) {
    return (
        <blockquote
            {...props}
            className={cn(
                'aui-md-blockquote border-l-4 border-[var(--app-hint)] pl-3 opacity-85',
                props.className
            )}
        />
    )
}

function UnorderedList(props: ComponentPropsWithoutRef<'ul'>) {
    return <ul {...props} className={cn('aui-md-ul list-disc pl-6', props.className)} />
}

function OrderedList(props: ComponentPropsWithoutRef<'ol'>) {
    return <ol {...props} className={cn('aui-md-ol list-decimal pl-6', props.className)} />
}

function ListItem(props: ComponentPropsWithoutRef<'li'>) {
    return <li {...props} className={cn('aui-md-li', props.className)} />
}

function Hr(props: ComponentPropsWithoutRef<'hr'>) {
    return <hr {...props} className={cn('aui-md-hr border-[var(--app-divider)]', props.className)} />
}

function Table(props: ComponentPropsWithoutRef<'table'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-table-wrapper max-w-full overflow-x-auto">
            <table {...rest} className={cn('aui-md-table w-full border-collapse', className)} />
        </div>
    )
}

function Thead(props: ComponentPropsWithoutRef<'thead'>) {
    return <thead {...props} className={cn('aui-md-thead', props.className)} />
}

function Tbody(props: ComponentPropsWithoutRef<'tbody'>) {
    return <tbody {...props} className={cn('aui-md-tbody', props.className)} />
}

function Tr(props: ComponentPropsWithoutRef<'tr'>) {
    return <tr {...props} className={cn('aui-md-tr', props.className)} />
}

function Th(props: ComponentPropsWithoutRef<'th'>) {
    return (
        <th
            {...props}
            className={cn(
                'aui-md-th border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-left font-semibold',
                props.className
            )}
        />
    )
}

function Td(props: ComponentPropsWithoutRef<'td'>) {
    return <td {...props} className={cn('aui-md-td border border-[var(--app-border)] px-2 py-1', props.className)} />
}

function H1(props: ComponentPropsWithoutRef<'h1'>) {
    return <h1 {...props} className={cn('aui-md-h1 mt-3 text-base font-semibold', props.className)} />
}

function H2(props: ComponentPropsWithoutRef<'h2'>) {
    return <h2 {...props} className={cn('aui-md-h2 mt-3 text-sm font-semibold', props.className)} />
}

function H3(props: ComponentPropsWithoutRef<'h3'>) {
    return <h3 {...props} className={cn('aui-md-h3 mt-2 text-sm font-semibold', props.className)} />
}

function H4(props: ComponentPropsWithoutRef<'h4'>) {
    return <h4 {...props} className={cn('aui-md-h4 mt-2 text-sm font-semibold', props.className)} />
}

function H5(props: ComponentPropsWithoutRef<'h5'>) {
    return <h5 {...props} className={cn('aui-md-h5 mt-2 text-sm font-semibold', props.className)} />
}

function H6(props: ComponentPropsWithoutRef<'h6'>) {
    return <h6 {...props} className={cn('aui-md-h6 mt-2 text-sm font-semibold', props.className)} />
}

function Strong(props: ComponentPropsWithoutRef<'strong'>) {
    return <strong {...props} className={cn('aui-md-strong font-semibold', props.className)} />
}

function Em(props: ComponentPropsWithoutRef<'em'>) {
    return <em {...props} className={cn('aui-md-em italic', props.className)} />
}

function Image(props: ComponentPropsWithoutRef<'img'>) {
    return <img {...props} className={cn('aui-md-img max-w-full rounded', props.className)} />
}

export const defaultComponents = memoizeMarkdownComponents({
    SyntaxHighlighter,
    CodeHeader,
    pre: Pre,
    code: Code,
    h1: H1,
    h2: H2,
    h3: H3,
    h4: H4,
    h5: H5,
    h6: H6,
    a: A,
    p: Paragraph,
    strong: Strong,
    em: Em,
    blockquote: Blockquote,
    ul: UnorderedList,
    ol: OrderedList,
    li: ListItem,
    hr: Hr,
    table: Table,
    thead: Thead,
    tbody: Tbody,
    tr: Tr,
    th: Th,
    td: Td,
    img: Image,
} as const)

export function MarkdownText() {
    return (
        <MarkdownTextPrimitive
            remarkPlugins={MARKDOWN_PLUGINS}
            components={defaultComponents}
            className={cn('aui-md min-w-0 max-w-full break-words text-sm')}
        />
    )
}
