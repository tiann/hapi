import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
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

const FILE_INSPECTION_COMMAND_RE = /\b(get-childitem|ls|dir|get-content|cat|type|tree)\b/i
const CONTENT_SEARCH_COMMAND_RE = /\b(rg|grep|select-string|findstr)\b/i

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

export function formatGroupedHeaderTitle(block: ToolGroupBlock, t: Translator): string {
    const label = getIntentLabel(getPrimaryIntent(block), t)
    const extraCount = block.tools.length - 1
    return extraCount > 0 ? `${label} +${extraCount}` : label
}

export function formatGroupedHeaderSubtitle(block: ToolGroupBlock, t: Translator): string | null {
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
    if (block.summary.countsByKind.other > 0) {
        parts.push(t('toolGroup.summary.other', { n: block.summary.countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
}

export function formatGroupedRowLabel(tool: ToolCallBlock, t: Translator): string {
    return getIntentLabel(inferGroupedSummaryIntent(tool), t)
}
