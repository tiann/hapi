export type ToolPresentation = {
    icon: string
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
    childrenCount: number
    description: string | null
}

export const knownTools: Record<string, {
    icon: string
    title: (opts: ToolOpts) => string
    subtitle?: (opts: ToolOpts) => string | null
    minimal?: boolean | ((opts: ToolOpts) => boolean)
}> = {
    Task: {
        icon: '🚀',
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
        icon: '🖥️',
        title: (opts) => opts.description ?? 'Terminal',
        subtitle: (opts) => getInputStringAny(opts.input, ['command', 'cmd']),
        minimal: true
    },
    CodexBash: {
        icon: '🖥️',
        title: (opts) => opts.description ?? 'Terminal',
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
        icon: '👁️',
        title: () => 'Read',
        subtitle: (opts) => getInputStringAny(opts.input, ['file_path', 'path', 'file']),
        minimal: true
    },
    Edit: {
        icon: '📝',
        title: () => 'Edit',
        subtitle: (opts) => getInputStringAny(opts.input, ['file_path', 'path']),
        minimal: false
    },
    MultiEdit: {
        icon: '📝',
        title: () => 'MultiEdit',
        subtitle: (opts) => getInputStringAny(opts.input, ['file_path', 'path']),
        minimal: false
    },
    Write: {
        icon: '📝',
        title: () => 'Write',
        subtitle: (opts) => getInputStringAny(opts.input, ['file_path', 'path']),
        minimal: false
    },
    WebFetch: {
        icon: '🌐',
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
        icon: '🌐',
        title: (opts) => getInputStringAny(opts.input, ['query']) ?? 'Web search',
        subtitle: (opts) => {
            const query = getInputStringAny(opts.input, ['query'])
            return query ? truncate(query, 80) : null
        },
        minimal: true
    },
    CodexPatch: {
        icon: '🩹',
        title: () => 'Apply changes',
        subtitle: (opts) => {
            if (isObject(opts.input) && isObject(opts.input.changes)) {
                const files = Object.keys(opts.input.changes)
                if (files.length === 0) return null
                const first = files[0]
                const basename = first.split('/').pop() ?? first
                return files.length > 1 ? `${basename} (+${files.length - 1})` : basename
            }
            return null
        },
        minimal: true
    },
    CodexDiff: {
        icon: '🧾',
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
        minimal: false
    },
    ExitPlanMode: {
        icon: '📋',
        title: () => 'Plan proposal',
        minimal: false
    },
    exit_plan_mode: {
        icon: '📋',
        title: () => 'Plan proposal',
        minimal: false
    }
}

export function getToolPresentation(opts: ToolOpts): ToolPresentation {
    if (opts.toolName.startsWith('mcp__')) {
        return {
            icon: '🔌',
            title: formatMCPTitle(opts.toolName),
            subtitle: null,
            minimal: true
        }
    }

    const known = knownTools[opts.toolName]
    if (known) {
        const minimal = typeof known.minimal === 'function' ? known.minimal(opts) : (known.minimal ?? false)
        return {
            icon: known.icon,
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
        icon: '🔧',
        title: opts.toolName,
        subtitle: subtitle ? truncate(subtitle, 80) : null,
        minimal: true
    }
}
