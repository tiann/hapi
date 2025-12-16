import { useMemo, useState } from 'react'
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-async-light'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import { useTheme } from '@/hooks/useTheme'

type SyntaxHighlighterWithSupportedLanguages = typeof SyntaxHighlighter & {
    supportedLanguages?: string[]
}

const SUPPORTED_LANGUAGE_LOOKUP = new Map(
    ((SyntaxHighlighter as SyntaxHighlighterWithSupportedLanguages).supportedLanguages ?? []).map(
        (lang: string): [string, string] => [canonicalizeLanguage(lang), lang]
    )
)

function canonicalizeLanguage(value: string): string {
    return value
        .trim()
        .replace(/^language-/, '')
        .toLowerCase()
        .replace(/#/g, 'sharp')
        .replace(/\+/g, 'p')
        .replace(/[^a-z0-9]/g, '')
}

function normalizeLanguage(language?: string): string {
    const raw = language?.trim()
    if (!raw) return 'text'

    const canonical = canonicalizeLanguage(raw)
    if (!canonical || canonical === 'text' || canonical === 'plaintext' || canonical === 'txt') return 'text'

    const supported = SUPPORTED_LANGUAGE_LOOKUP.get(canonical)
    if (supported) return supported

    return raw.startsWith('language-') ? raw.slice('language-'.length) : raw
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
    const { isDark } = useTheme()

    const [copied, setCopied] = useState(false)

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

    const syntaxTheme = isDark ? oneDark : oneLight

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

            <div className="overflow-auto p-2 pr-8 text-xs">
                <SyntaxHighlighter
                    language={normalizedLanguage}
                    style={syntaxTheme}
                    PreTag="div"
                    customStyle={{ margin: 0, padding: 0, background: 'transparent' }}
                >
                    {props.code}
                </SyntaxHighlighter>
            </div>
        </div>
    )
}
