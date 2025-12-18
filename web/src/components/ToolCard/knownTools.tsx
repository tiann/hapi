import type { ReactNode } from 'react'
import type { SessionMetadataSummary } from '@/types/api'
import { BulbIcon, ClipboardIcon, EyeIcon, FileDiffIcon, GlobeIcon, PuzzleIcon, QuestionIcon, RocketIcon, SearchIcon, TerminalIcon, WrenchIcon } from '@/components/ToolCard/icons'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

const DEFAULT_ICON_CLASS = 'h-3.5 w-3.5'
// Tool presentation registry for `hapi/web` (aligned with `happy-app`).

export type ToolPresentation = {
    icon: ReactNode
    title: string
    subtitle: string | null
    minimal: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    if (!isObject(input)) return null
    for (const key of keys) {
        const value = input[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

function countLines(text: string): number {
    return text.split('\n').length
}

function snakeToTitleWithSpaces(value: string): string {
    return value
        .split('_')
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ')
}

function formatMCPTitle(toolName: string): string {
    const withoutPrefix = toolName.replace(/^mcp__/, '')
    const parts = withoutPrefix.split('__')
    if (parts.length >= 2) {
        const serverName = snakeToTitleWithSpaces(parts[0])
        const toolPart = snakeToTitleWithSpaces(parts.slice(1).join('_'))
        return `MCP: ${serverName} ${toolPart}`
    }
    return `MCP: ${snakeToTitleWithSpaces(withoutPrefix)}`
}

type ToolOpts = {
    toolName: string
    input: unknown
    result: unknown
    childrenCount: number
    description: string | null
    metadata: SessionMetadataSummary | null
}

export const knownTools: Record<string, {
    icon: (opts: ToolOpts) => ReactNode
    title: (opts: ToolOpts) => string
    subtitle?: (opts: ToolOpts) => string | null
    minimal?: boolean | ((opts: ToolOpts) => boolean)
}> = {
    Task: {
        icon: () => <RocketIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const description = getInputStringAny(opts.input, ['description'])
            return description ?? 'Task'
        },
        subtitle: (opts) => {
            const prompt = getInputStringAny(opts.input, ['prompt'])
            return prompt ? truncate(prompt, 120) : null
        },
        minimal: (opts) => opts.childrenCount === 0
    },
    Bash: {
        icon: () => <TerminalIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => opts.description ?? 'Terminal',
        subtitle: (opts) => getInputStringAny(opts.input, ['command', 'cmd']),
        minimal: true
    },
    Glob: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['pattern']) ?? 'Search files',
        minimal: true
    },
    Grep: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const pattern = getInputStringAny(opts.input, ['pattern'])
            return pattern ? `grep(pattern: ${pattern})` : 'Search content'
        },
        minimal: true
    },
    LS: {
        icon: () => <SearchIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'List files'
        },
        minimal: true
    },
    CodexBash: {
        icon: (opts) => {
            if (isObject(opts.input) && Array.isArray(opts.input.parsed_cmd) && opts.input.parsed_cmd.length > 0) {
                const first = opts.input.parsed_cmd[0]
                const type = isObject(first) ? first.type : null
                if (type === 'read') return <EyeIcon className={DEFAULT_ICON_CLASS} />
                if (type === 'write') return <FileDiffIcon className={DEFAULT_ICON_CLASS} />
            }
            return <TerminalIcon className={DEFAULT_ICON_CLASS} />
        },
        title: (opts) => {
            if (isObject(opts.input) && Array.isArray(opts.input.parsed_cmd) && opts.input.parsed_cmd.length === 1) {
                const parsed = opts.input.parsed_cmd[0]
                if (isObject(parsed) && parsed.type === 'read' && typeof parsed.name === 'string') {
                    return resolveDisplayPath(parsed.name, opts.metadata)
                }
            }
            return opts.description ?? 'Terminal'
        },
        subtitle: (opts) => {
            const command = getInputStringAny(opts.input, ['command', 'cmd'])
            if (command) return command
            if (isObject(opts.input) && Array.isArray(opts.input.command)) {
                return opts.input.command.filter((part) => typeof part === 'string').join(' ')
            }
            return null
        },
        minimal: true
    },
    Read: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path', 'file'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Read file'
        },
        minimal: true
    },
    Edit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Edit file'
        },
        minimal: true
    },
    MultiEdit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            if (!file) return 'Edit file'
            const edits = isObject(opts.input) && Array.isArray(opts.input.edits) ? opts.input.edits : null
            const count = edits ? edits.length : 0
            const path = resolveDisplayPath(file, opts.metadata)
            return count > 1 ? `${path} (${count} edits)` : path
        },
        minimal: true
    },
    Write: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const file = getInputStringAny(opts.input, ['file_path', 'path'])
            return file ? resolveDisplayPath(file, opts.metadata) : 'Write file'
        },
        subtitle: (opts) => {
            const content = getInputStringAny(opts.input, ['content', 'text'])
            if (!content) return null
            const lines = countLines(content)
            return lines > 1 ? `${lines} lines` : `${content.length} chars`
        },
        minimal: true
    },
    WebFetch: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            if (!url) return 'Web fetch'
            try {
                return new URL(url).hostname
            } catch {
                return url
            }
        },
        subtitle: (opts) => {
            const url = getInputStringAny(opts.input, ['url'])
            if (!url) return null
            return url
        },
        minimal: true
    },
    WebSearch: {
        icon: () => <GlobeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['query']) ?? 'Web search',
        subtitle: (opts) => {
            const query = getInputStringAny(opts.input, ['query'])
            return query ? truncate(query, 80) : null
        },
        minimal: true
    },
    NotebookRead: {
        icon: () => <EyeIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['notebook_path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'Read notebook'
        },
        minimal: true
    },
    NotebookEdit: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const path = getInputStringAny(opts.input, ['notebook_path'])
            return path ? resolveDisplayPath(path, opts.metadata) : 'Edit notebook'
        },
        subtitle: (opts) => {
            const mode = getInputStringAny(opts.input, ['edit_mode'])
            return mode ? `mode: ${mode}` : null
        },
        minimal: false
    },
    TodoWrite: {
        icon: () => <BulbIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Todo list',
        subtitle: (opts) => {
            const todos = isObject(opts.input) && Array.isArray(opts.input.todos) ? opts.input.todos : null
            if (todos && todos.length > 0) return `${todos.length} items`
            const newTodos = isObject(opts.result) && Array.isArray(opts.result.newTodos) ? opts.result.newTodos : null
            if (newTodos && newTodos.length > 0) return `${newTodos.length} items`
            return null
        },
        minimal: (opts) => {
            const todos = isObject(opts.input) && Array.isArray(opts.input.todos) ? opts.input.todos : null
            if (todos && todos.length > 0) return false
            const newTodos = isObject(opts.result) && Array.isArray(opts.result.newTodos) ? opts.result.newTodos : null
            if (newTodos && newTodos.length > 0) return false
            return true
        }
    },
    CodexReasoning: {
        icon: () => <BulbIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => getInputStringAny(opts.input, ['title']) ?? 'Reasoning',
        minimal: true
    },
    CodexPatch: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Apply changes',
        subtitle: (opts) => {
            if (isObject(opts.input) && isObject(opts.input.changes)) {
                const files = Object.keys(opts.input.changes)
                if (files.length === 0) return null
                const first = files[0]
                const display = resolveDisplayPath(first, opts.metadata)
                const name = basename(display)
                return files.length > 1 ? `${name} (+${files.length - 1})` : name
            }
            return null
        },
        minimal: true
    },
    CodexDiff: {
        icon: () => <FileDiffIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Diff',
        subtitle: (opts) => {
            const unified = getInputStringAny(opts.input, ['unified_diff'])
            if (!unified) return null
            const lines = unified.split('\n')
            for (const line of lines) {
                if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
                    const fileName = line.replace(/^\+\+\+ (b\/)?/, '')
                    return fileName.split('/').pop() ?? fileName
                }
            }
            return null
        },
        minimal: (opts) => {
            const unified = getInputStringAny(opts.input, ['unified_diff'])
            if (!unified) return true
            return unified.length >= 2000 || countLines(unified) >= 50
        }
    },
    ExitPlanMode: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Plan proposal',
        minimal: false
    },
    exit_plan_mode: {
        icon: () => <ClipboardIcon className={DEFAULT_ICON_CLASS} />,
        title: () => 'Plan proposal',
        minimal: false
    },
    AskUserQuestion: {
        icon: () => <QuestionIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const first = isObject(opts.input) && Array.isArray(opts.input.questions) ? opts.input.questions[0] : null
            const header = isObject(first) && typeof first.header === 'string' ? first.header.trim() : ''
            return header.length > 0 ? header : 'Question'
        },
        subtitle: (opts) => {
            const first = isObject(opts.input) && Array.isArray(opts.input.questions) ? opts.input.questions[0] : null
            const question = isObject(first) && typeof first.question === 'string' ? first.question.trim() : ''
            return question.length > 0 ? truncate(question, 120) : null
        },
        minimal: true
    },
    ask_user_question: {
        icon: () => <QuestionIcon className={DEFAULT_ICON_CLASS} />,
        title: (opts) => {
            const first = isObject(opts.input) && Array.isArray(opts.input.questions) ? opts.input.questions[0] : null
            const header = isObject(first) && typeof first.header === 'string' ? first.header.trim() : ''
            return header.length > 0 ? header : 'Question'
        },
        subtitle: (opts) => {
            const first = isObject(opts.input) && Array.isArray(opts.input.questions) ? opts.input.questions[0] : null
            const question = isObject(first) && typeof first.question === 'string' ? first.question.trim() : ''
            return question.length > 0 ? truncate(question, 120) : null
        },
        minimal: true
    }
}

export function getToolPresentation(opts: Omit<ToolOpts, 'metadata'> & { metadata: SessionMetadataSummary | null }): ToolPresentation {
    if (opts.toolName.startsWith('mcp__')) {
        return {
            icon: <PuzzleIcon className={DEFAULT_ICON_CLASS} />,
            title: formatMCPTitle(opts.toolName),
            subtitle: null,
            minimal: true
        }
    }

    const known = knownTools[opts.toolName]
    if (known) {
        const minimal = typeof known.minimal === 'function' ? known.minimal(opts) : (known.minimal ?? false)
        return {
            icon: known.icon(opts),
            title: known.title(opts),
            subtitle: known.subtitle ? known.subtitle(opts) : null,
            minimal
        }
    }

    const filePath = getInputStringAny(opts.input, ['file_path', 'path', 'filePath', 'file'])
    const command = getInputStringAny(opts.input, ['command', 'cmd'])
    const pattern = getInputStringAny(opts.input, ['pattern'])
    const url = getInputStringAny(opts.input, ['url'])
    const query = getInputStringAny(opts.input, ['query'])

    const subtitle = filePath ?? command ?? pattern ?? url ?? query

    return {
        icon: <WrenchIcon className={DEFAULT_ICON_CLASS} />,
        title: opts.toolName,
        subtitle: subtitle ? truncate(subtitle, 80) : null,
        minimal: true
    }
}
