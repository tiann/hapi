import { Children, Fragment, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'

export type DocPathSegment = {
    type: 'text' | 'path'
    value: string
}

const DOC_MARKDOWN_PATH_PATTERN = /docs\/[^\s`"'<>()[\]{}]+?\.md(?=$|[\s`"'<>()[\]{},;:!?]|\.(?:\s|$))/g

export function splitDocPathText(text: string): DocPathSegment[] {
    const segments: DocPathSegment[] = []
    let lastIndex = 0

    for (const match of text.matchAll(DOC_MARKDOWN_PATH_PATTERN)) {
        const path = match[0]
        const index = match.index ?? 0
        if (index > lastIndex) {
            segments.push({ type: 'text', value: text.slice(lastIndex, index) })
        }
        segments.push({ type: 'path', value: path })
        lastIndex = index + path.length
    }

    if (lastIndex < text.length) {
        segments.push({ type: 'text', value: text.slice(lastIndex) })
    }

    return segments.length > 0 ? segments : [{ type: 'text', value: text }]
}

function DocPathCopyButton(props: { path: string }) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const label = t('markdown.copyDocPath', { path: props.path })

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            className="ml-1 inline-flex h-5 w-5 items-center justify-center align-[-0.2em] text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] sm:hidden"
            onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void copy(props.path)
            }}
        >
            {copied
                ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                : <CopyIcon className="h-3.5 w-3.5" />}
        </button>
    )
}

export function CopyableDocPathText(props: { text: string }) {
    const segments = splitDocPathText(props.text)

    return (
        <>
            {segments.map((segment, index) => (
                <Fragment key={`${segment.type}-${index}-${segment.value}`}>
                    {segment.value}
                    {segment.type === 'path' ? <DocPathCopyButton path={segment.value} /> : null}
                </Fragment>
            ))}
        </>
    )
}

export function renderDocPathCopyChildren(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
        if (typeof child === 'string') {
            return <CopyableDocPathText text={child} />
        }
        return child
    })
}
