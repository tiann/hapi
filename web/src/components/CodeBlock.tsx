import { useState } from 'react'
import { usePlatform } from '@/hooks/usePlatform'
import { useShikiHighlighter } from '@/lib/shiki'

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

export function CodeBlock(props: {
    code: string
    language?: string
    showCopyButton?: boolean
}) {
    const { haptic } = usePlatform()
    const showCopyButton = props.showCopyButton ?? true

    const [copied, setCopied] = useState(false)

    const highlighted = useShikiHighlighter(props.code, props.language)

    const handleCopy = async () => {
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
        <div className="relative min-w-0 max-w-full">
            {showCopyButton ? (
                <button
                    type="button"
                    onClick={handleCopy}
                    className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    title="Copy"
                >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            ) : null}

            <div className="min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-md bg-[var(--app-code-bg)]">
                <pre className="shiki m-0 w-max min-w-full p-2 pr-8 text-xs font-mono">
                    <code className="block">{highlighted ?? props.code}</code>
                </pre>
            </div>
        </div>
    )
}
