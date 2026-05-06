import { useMemo } from 'react'
import { stripAnsiAndControls } from '@/components/assistant-ui/markdown-utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CodeBlock } from '@/components/CodeBlock'
import { useTranslation } from '@/lib/use-translation'

const CLI_TAG_PATTERN = '(?:local-command-[a-z-]+|command-(?:name|message|args))'
const CLI_TAG_CHECK_REGEX = new RegExp(`<${CLI_TAG_PATTERN}>`, 'i')
const CLI_TAG_REGEX_SOURCE = `<(${CLI_TAG_PATTERN})>([\\s\\S]*?)<\\/\\1>`
const BR_REGEX = /<br\s*\/?>/gi

const LABELS: Record<string, string> = {
    'command-name': 'terminal.commandName',
    'command-message': 'terminal.commandMessage',
    'command-args': 'terminal.commandArgs',
    'local-command-stdout': 'terminal.stdout',
    'local-command-stderr': 'terminal.stderr',
}
const COMMAND_NAME_REGEX = /<command-name>([\s\S]*?)<\/command-name>/i
const PREVIEW_LINE_THRESHOLD = 14
const PREVIEW_CHAR_THRESHOLD = 1600
const PREVIEW_MAX_HEIGHT = 220

export function hasCliOutputTags(text: string): boolean {
    return CLI_TAG_CHECK_REGEX.test(text)
}

function normalizeCliText(text: string): string {
    const withoutAnsi = stripAnsiAndControls(text)
    return withoutAnsi.replace(BR_REGEX, '\n')
}

function formatLabel(tag: string, t?: (key: string) => string): string {
    const normalized = tag.toLowerCase()
    if (LABELS[normalized]) {
        return t ? t(LABELS[normalized]) : LABELS[normalized]
    }
    return normalized.replace(/-/g, ' ')
}

function buildCliOutput(text: string, t?: (key: string) => string): string {
    const matches = Array.from(text.matchAll(new RegExp(CLI_TAG_REGEX_SOURCE, 'gi')))
    if (matches.length === 0) {
        return normalizeCliText(text)
    }

    const sections: string[] = []
    let lastIndex = 0

    for (const match of matches) {
        const startIndex = match.index ?? 0
        if (startIndex > lastIndex) {
            const before = normalizeCliText(text.slice(lastIndex, startIndex))
            if (before.trim().length > 0) {
                sections.push(before.trimEnd())
            }
        }

        const tagName = match[1] ?? ''
        const content = normalizeCliText(match[2] ?? '')
        const label = formatLabel(tagName, t)

        if (content.length > 0) {
            sections.push(`${label}:\n${content}`)
        } else {
            sections.push(`${label}:`)
        }

        lastIndex = startIndex + match[0].length
    }

    if (lastIndex < text.length) {
        const tail = normalizeCliText(text.slice(lastIndex))
        if (tail.trim().length > 0) {
            sections.push(tail.trimEnd())
        }
    }

    return sections.join('\n\n')
}

function shouldCollapsePreview(text: string): boolean {
    if (text.length > PREVIEW_CHAR_THRESHOLD) return true
    return text.split('\n').length > PREVIEW_LINE_THRESHOLD
}

function extractCommandName(text: string): string | null {
    const match = text.match(COMMAND_NAME_REGEX)
    if (!match) return null
    const normalized = normalizeCliText(match[1] ?? '')
    const firstLine = normalized.split('\n').find((line) => line.trim().length > 0)?.trim()
    return firstLine && firstLine.length > 0 ? firstLine : null
}

function DetailsIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function CliIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M3 4.5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8.5 10.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

export function CliOutputBlock(props: { text: string }) {
    const { t } = useTranslation()
    const content = useMemo(() => buildCliOutput(props.text, t), [props.text, t])
    const commandName = useMemo(() => extractCommandName(props.text), [props.text])
    const isCollapsedPreview = useMemo(() => shouldCollapsePreview(content), [content])
    const title = commandName ?? t('terminal.commandName')

    return (
        <div className="overflow-hidden rounded-[20px] bg-[var(--app-tool-card-bg)] p-3 shadow-none">
            <Dialog>
                <DialogTrigger asChild>
                    <button type="button" className="w-full text-left">
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex items-center gap-2">
                                    <div className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                                        <CliIcon />
                                    </div>
                                    <div className="min-w-0 truncate text-sm font-medium leading-tight text-[var(--app-fg)]">
                                        {title}
                                    </div>
                                </div>
                                <span className="text-[var(--app-hint)]">
                                    <DetailsIcon />
                                </span>
                            </div>
                            <CodeBlock
                                code={content}
                                language="shellscript"
                                title="Terminal output"
                                showCopyButton={false}
                                collapseLongContent={isCollapsedPreview}
                                collapsedHeight={PREVIEW_MAX_HEIGHT}
                            />
                        </div>
                    </button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                    </DialogHeader>
                    <div className="mt-3 max-h-[75vh] overflow-auto">
                        <CodeBlock code={content} language="shellscript" title="Terminal output" />
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
