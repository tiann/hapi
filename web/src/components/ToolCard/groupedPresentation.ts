import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import { isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import { getInputStringAny } from '@/lib/toolInputUtils'

type Translator = (key: string, params?: Record<string, string | number>) => string

export type GroupedSummaryIntent =
    | 'inspect-files'
    | 'search-content'
    | 'run-project-command'
    | 'modify-files'
    | 'open-web'
    | 'generic-command'
    | 'generic-tool'

const FILE_INSPECTION_COMMAND_RE = /\b(get-childitem|ls|dir|get-content|cat|type|tree)\b|\bsed\s+-n\b/i
const CONTENT_SEARCH_COMMAND_RE = /\b(rg|grep|select-string|findstr)\b/i
const SAFE_PROJECT_COMMAND_RE = /^(?:(?:bun|npm|pnpm|yarn) (?:run )?(?:test|lint|build|typecheck)(?:[:\w.-]*)|git (?:status|diff|log)(?:\s+--?[\w.-]+)*|cargo (?:test|check)|go test(?:\s+\.\/\.\.\.)?|pytest(?:\s+-[\w-]+)*)$/i
const SENSITIVE_TEXT_RE = /(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret)(?:\s*[:=]\s*\S+|\s+\S{12,})|(?:gh[pousr]_|github_pat_|sk-[a-z0-9_-]*|xox[baprs]-)[a-z0-9_-]{12,}|[a-f0-9]{32,}|[a-z0-9_+/=-]{40,})/i
const SEARCH_OPTIONS_WITH_VALUE = new Set([
    '-g', '--glob', '-t', '--type', '-A', '-B', '-C', '--context',
    '--before-context', '--after-context', '-m', '--max-count'
])
const MAX_SPECIFIC_LABEL_LENGTH = 72

function truncateLabel(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > MAX_SPECIFIC_LABEL_LENGTH
        ? `${normalized.slice(0, MAX_SPECIFIC_LABEL_LENGTH - 1)}…`
        : normalized
}

export function safeGroupedLabelValue(value: string | null): string | null {
    if (!value || SENSITIVE_TEXT_RE.test(value)) return null
    return truncateLabel(value)
}

function basename(value: string): string {
    const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts.at(-1) ?? value
}

function simpleCommandParts(command: string): string[] | null {
    if (/[;&|<>$`(){}\n\r]/.test(command)) return null
    return command.trim().split(/\s+/).filter(Boolean)
}

function getInspectionCommandTarget(command: string): string | null {
    const parts = simpleCommandParts(command)
    if (!parts || parts.length < 2) return null
    const target = [...parts].reverse().find((part) => !part.startsWith('-') && !/^['"]?\d+(?:,\d+)?p['"]?$/.test(part))
    if (!target || target === parts[0]) return null
    return safeGroupedLabelValue(target.replace(/^['"]|['"]$/g, ''))
}

function getSearchCommandPattern(command: string): string | null {
    const parts = simpleCommandParts(command)
    if (!parts) return null
    const executableIndex = parts.findIndex((part) => /^(?:rg|grep|select-string|findstr)$/i.test(part))
    if (executableIndex < 0) return null
    for (let index = executableIndex + 1; index < parts.length; index += 1) {
        const part = parts[index]
        if (!part.startsWith('-')) return safeGroupedLabelValue(part.replace(/^['"]|['"]$/g, ''))
        if (SEARCH_OPTIONS_WITH_VALUE.has(part)) index += 1
    }
    return null
}

function getCommandText(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

function getIntentLabel(intent: GroupedSummaryIntent, t: Translator): string {
    switch (intent) {
        case 'inspect-files':
            return t('toolGroup.friendly.inspectFiles')
        case 'search-content':
            return t('toolGroup.friendly.searchContent')
        case 'run-project-command':
            return t('toolGroup.friendly.runCommands')
        case 'modify-files':
            return t('toolGroup.friendly.editFiles')
        case 'open-web':
            return t('toolGroup.friendly.openWeb')
        case 'generic-command':
            return t('toolGroup.friendly.genericCommand')
        default:
            return t('toolGroup.friendly.genericTool')
    }
}

export function inferGroupedSummaryIntent(tool: ToolCallBlock): GroupedSummaryIntent {
    const toolName = tool.tool.name
    const command = getCommandText(tool.tool.input)

    if (toolName === 'Read' || toolName === 'LS' || toolName === 'NotebookRead') {
        return 'inspect-files'
    }
    if (toolName === 'Grep' || toolName === 'Glob') {
        return 'search-content'
    }
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'CodexPatch' || toolName === 'CodexDiff') {
        return 'modify-files'
    }
    if (toolName === 'WebFetch' || toolName === 'WebSearch') {
        return 'open-web'
    }

    if (toolName === 'Bash' || toolName === 'CodexBash' || toolName === 'shell_command') {
        if (command && FILE_INSPECTION_COMMAND_RE.test(command)) {
            return 'inspect-files'
        }
        if (command && CONTENT_SEARCH_COMMAND_RE.test(command)) {
            return 'search-content'
        }
        return 'run-project-command'
    }

    return 'generic-tool'
}

function getPrimaryIntent(block: ToolGroupBlock): GroupedSummaryIntent {
    const counts = new Map<GroupedSummaryIntent, number>()
    const order: GroupedSummaryIntent[] = []

    for (const tool of block.tools) {
        const intent = inferGroupedSummaryIntent(tool)
        if (!counts.has(intent)) {
            order.push(intent)
        }
        counts.set(intent, (counts.get(intent) ?? 0) + 1)
    }

    let primary: GroupedSummaryIntent = 'generic-tool'
    let maxCount = -1

    for (const intent of order) {
        const count = counts.get(intent) ?? 0
        if (count > maxCount) {
            primary = intent
            maxCount = count
        }
    }

    return primary
}

function formatSpecificIntentTitle(block: ToolGroupBlock, intent: GroupedSummaryIntent, t: Translator): string | null {
    const matching = block.tools.filter((tool) => inferGroupedSummaryIntent(tool) === intent)
    const described = matching
        .map((tool) => safeGroupedLabelValue(tool.tool.description))
        .find((value): value is string => value !== null)
    if (described) return described

    if (intent === 'inspect-files' || intent === 'modify-files') {
        for (const tool of matching) {
            const target = safeGroupedLabelValue(getInputStringAny(tool.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path']))
            if (target) {
                return t(intent === 'modify-files' ? 'toolGroup.friendly.editTarget' : 'toolGroup.friendly.inspectTarget', {
                    target: basename(target)
                })
            }
            if (intent === 'inspect-files') {
                const command = getCommandText(tool.tool.input)
                const commandTarget = command ? getInspectionCommandTarget(command) : null
                if (commandTarget) return t('toolGroup.friendly.inspectTarget', { target: basename(commandTarget) })
            }
        }
    }

    if (intent === 'search-content') {
        for (const tool of matching) {
            const pattern = safeGroupedLabelValue(getInputStringAny(tool.tool.input, ['pattern', 'query']))
            if (pattern) return t('toolGroup.friendly.searchTarget', { target: pattern })
            const command = getCommandText(tool.tool.input)
            const commandPattern = command ? getSearchCommandPattern(command) : null
            if (commandPattern) return t('toolGroup.friendly.searchTarget', { target: commandPattern })
        }
    }

    if (intent === 'run-project-command') {
        for (const tool of matching) {
            const command = safeGroupedLabelValue(getCommandText(tool.tool.input))
            if (command && SAFE_PROJECT_COMMAND_RE.test(command)) {
                return t('toolGroup.friendly.runTarget', { target: command })
            }
        }
    }

    return null
}

export function formatGroupedHeaderTitle(block: ToolGroupBlock, t: Translator): string {
    if (block.presentationMode === 'codex-exploration') {
        return block.tools.some((tool) => tool.tool.state === 'running' || tool.tool.state === 'pending')
            ? t('toolGroup.codex.exploring')
            : t('toolGroup.codex.explored')
    }
    const activityTitle = safeGroupedLabelValue(block.activityTitle ?? null)
    if (activityTitle) return activityTitle
    const primaryIntent = getPrimaryIntent(block)
    const specificTitle = formatSpecificIntentTitle(block, primaryIntent, t)
    if (specificTitle) return specificTitle
    if (primaryIntent === 'generic-tool') {
        return t('toolGroup.title')
    }
    return getIntentLabel(primaryIntent, t)
}

export function formatGroupedHeaderSubtitle(block: ToolGroupBlock, t: Translator): string | null {
    if (block.presentationMode === 'codex-exploration') return null
    const parts: string[] = []

    if (block.summary.countsByKind.command > 0) {
        parts.push(t('toolGroup.summary.command', { n: block.summary.countsByKind.command }))
    }
    if (block.summary.countsByKind.search > 0) {
        parts.push(t('toolGroup.summary.search', { n: block.summary.countsByKind.search }))
    }
    if (block.summary.countsByKind.read > 0) {
        parts.push(t('toolGroup.summary.read', { n: block.summary.countsByKind.read }))
    }
    if (block.summary.countsByKind.mutation > 0) {
        parts.push(t('toolGroup.summary.mutation', { n: block.summary.countsByKind.mutation }))
    }
    if (block.summary.countsByKind.web > 0) {
        parts.push(t('toolGroup.summary.web', { n: block.summary.countsByKind.web }))
    }
    if (block.summary.countsByKind.other > 0 && parts.length > 0) {
        parts.push(t('toolGroup.summary.other', { n: block.summary.countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
}

export function formatGroupedRowLabel(tool: ToolCallBlock, t: Translator): string {
    if (isCodexExplorationTool(tool)) return t('toolGroup.codex.explored')
    return getIntentLabel(inferGroupedSummaryIntent(tool), t)
}
