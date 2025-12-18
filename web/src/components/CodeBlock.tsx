import type { Themes } from 'react-shiki/web'
import { useMemo, useState } from 'react'
import { useShikiHighlighter } from 'react-shiki/web'
import { getTelegramWebApp } from '@/hooks/useTelegram'

const SHIKI_THEMES: Themes = {
    light: 'github-light',
    dark: 'github-dark',
}

function normalizeLanguage(language?: string): string {
    const raw = language?.trim()
    if (!raw) return 'text'
    const cleaned = raw.startsWith('language-') ? raw.slice('language-'.length) : raw
    const canonical = cleaned.toLowerCase()
    if (canonical === 'text' || canonical === 'plaintext' || canonical === 'txt') return 'text'
    return cleaned
}

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
    const showCopyButton = props.showCopyButton ?? true
    const normalizedLanguage = useMemo(() => normalizeLanguage(props.language), [props.language])

    const [copied, setCopied] = useState(false)

    const highlighted = useShikiHighlighter(props.code, normalizedLanguage, SHIKI_THEMES, {
        delay: 75,
        outputFormat: 'react',
        structure: 'inline',
    })

    const handleCopy = async () => {
        try {
            await safeCopyToClipboard(props.code)
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('success')
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
        }
    }

    return (
        <div className="relative overflow-hidden rounded-md bg-[var(--app-code-bg)]">
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

            <pre className="overflow-auto p-2 pr-8 text-xs">
                {typeof highlighted === 'string' ? (
                    <code
                        className="shiki font-mono"
                        dangerouslySetInnerHTML={{ __html: highlighted }}
                    />
                ) : (
                    <code className="shiki font-mono">
                        {highlighted ?? props.code}
                    </code>
                )}
            </pre>
        </div>
    )
}
