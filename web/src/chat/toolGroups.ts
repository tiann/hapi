import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { getCodexCommandActions, isCodexExplorationTool } from '@/chat/codexCommandPresentation'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'
export type ToolGroupingMode = 'grouped' | 'classified'

export type ToolGroupSummary = {
    totalTools: number
    countsByKind: Record<ToolGroupActionKind, number>
    fileTargets: string[]
    commandTargets: string[]
    searchTargets: string[]
    urlTargets: string[]
    otherTargets: string[]
    errorCount: number
    runningCount: number
    pendingCount: number
}

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    createdAt: number
    invokedAt?: number | null
    firstToolId: string
    lastToolId: string
    tools: ToolCallBlock[]
    defaultOpen: boolean
    historyState: 'complete' | 'needs-older-history'
    needsOlderHistory: boolean
    activityTitle?: string | null
    presentationMode?: 'default' | 'codex-exploration'
    summary: ToolGroupSummary
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

export type VisibleChatBlockRole = 'user' | 'assistant' | 'system'

/**
 * The role a block renders under in the thread. `@assistant-ui/react` joins
 * adjacent assistant-role blocks into a single card, so this also determines
 * how many rows a run of blocks actually produces on screen.
 */
export function visibleBlockRole(block: VisibleChatBlock): VisibleChatBlockRole {
    if (block.kind === 'user-text') return 'user'
    if (block.kind === 'agent-event') return 'system'
    if (block.kind === 'cli-output') return block.source === 'user' ? 'user' : 'assistant'
    return 'assistant'
}

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
    previousGroupingMode?: ToolGroupingMode
    groupingMode?: ToolGroupingMode
    codexExplorationCollapsed?: boolean
}

const PLAN_TOOL_NAMES = new Set([
    'todowrite',
    'updateplan',
    'exitplanmode',
    'codexreasoning'
])

const MILESTONE_TOOL_NAMES = new Set([
    'task',
    'agent',
    'codexagent',
    'teamcreate',
    'teamdelete',
    'sendmessage',
    // agy's transitional task-log chip — keep it standalone (like SendMessage)
    // so it reads as a thin marker instead of being folded into a tool group.
    'agytasklog',
    'agyasynctask',
    'agyerror',
    'skill',
    'spawnagent',
    'sendinput',
    'resumeagent',
    'followuptask',
    'waitagent',
    'closeagent',
    'interruptagent',
    'listagents'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'codexpermission'
])

const READ_TOOL_NAMES = new Set([
    'read',
    'notebookread',
    'readfile',
    'viewfile',
    'fileread'
])

const SEARCH_TOOL_NAMES = new Set([
    'search',
    'grep',
    'glob',
    'ls',
    'listdir',
    'listfiles',
    'searchfiles',
    'grepsearch',
    'contentsearch'
])

const COMMAND_TOOL_NAMES = new Set([
    'bash',
    'codexbash',
    'shell',
    'shellcommand',
    'runshellcommand',
    'runcommand',
    'executecommand',
    'terminal'
])

const MUTATION_TOOL_NAMES = new Set([
    'edit',
    'multiedit',
    'write',
    'notebookedit',
    'codexpatch',
    'codexdiff',
    'editfile',
    'writefile',
    'replacefilecontent',
    'writetofile',
    'applypatch',
    'patch'
])

const WEB_TOOL_NAMES = new Set([
    'webfetch',
    'websearch',
    'fetchurl',
    'openurl',
    'urlfetch'
])

const READ_NATIVE_KINDS = new Set(['read', 'readfile', 'fileread', 'view', 'viewfile'])
const SEARCH_NATIVE_KINDS = new Set(['search', 'grep', 'find', 'glob'])
const COMMAND_NATIVE_KINDS = new Set(['execute', 'shell', 'bash', 'run', 'runshell', 'runshellcommand', 'cmd', 'terminal', 'command'])
const MUTATION_NATIVE_KINDS = new Set(['edit', 'write', 'writefile', 'replace', 'fileedit', 'modify', 'patch'])
const WEB_NATIVE_KINDS = new Set(['web', 'fetch', 'webfetch', 'websearch', 'openurl'])

function normalizeToolIdentifier(value: string | null | undefined): string {
    return value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') ?? ''
}

function pushUnique(target: string[], value: string | null): void {
    if (!value) return
    if (target.includes(value)) return
    target.push(value)
}

function normalizeCommandInput(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const codexActions = getCodexCommandActions(block)
    if (codexActions.length > 0) {
        if (codexActions.some((action) => action.type === 'unknown')) return 'command'
        if (codexActions.some((action) => action.type === 'search')) return 'search'
        return 'read'
    }

    const name = normalizeToolIdentifier(block.tool.name)
    if (WEB_TOOL_NAMES.has(name)) return 'web'
    if (READ_TOOL_NAMES.has(name)) return 'read'
    if (SEARCH_TOOL_NAMES.has(name)) return 'search'
    if (COMMAND_TOOL_NAMES.has(name)) return 'command'
    if (MUTATION_TOOL_NAMES.has(name)) return 'mutation'

    const nativeKind = normalizeToolIdentifier(block.tool.nativeKind)
    if (WEB_NATIVE_KINDS.has(nativeKind)) return 'web'
    if (READ_NATIVE_KINDS.has(nativeKind)) return 'read'
    if (SEARCH_NATIVE_KINDS.has(nativeKind)) return 'search'
    if (COMMAND_NATIVE_KINDS.has(nativeKind)) return 'command'
    if (MUTATION_NATIVE_KINDS.has(nativeKind)) return 'mutation'
    return 'other'
}

function getPrimaryFileTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path', 'name'])
}

function getPrimarySearchTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['pattern', 'query'])
}

function getPrimaryUrlTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['url'])
}

function getPrimaryOtherTarget(block: ToolCallBlock): string | null {
    const fileTarget = getPrimaryFileTarget(block)
    if (fileTarget) return fileTarget

    const searchTarget = getPrimarySearchTarget(block)
    if (searchTarget) return searchTarget

    const commandTarget = normalizeCommandInput(block.tool.input)
    if (commandTarget) return commandTarget

    const urlTarget = getPrimaryUrlTarget(block)
    if (urlTarget) return urlTarget

    return block.tool.name
}

function summarizeToolGroup(tools: ToolCallBlock[]): ToolGroupSummary {
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0
    }
    const fileTargets: string[] = []
    const commandTargets: string[] = []
    const searchTargets: string[] = []
    const urlTargets: string[] = []
    const otherTargets: string[] = []
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tool of tools) {
        const kind = getToolGroupActionKind(tool)
        countsByKind[kind] += 1

        if (tool.tool.state === 'error') {
            errorCount += 1
        } else if (tool.tool.state === 'running') {
            runningCount += 1
        } else if (tool.tool.state === 'pending') {
            pendingCount += 1
        }

        if (kind === 'read' || kind === 'mutation') {
            pushUnique(fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if (kind === 'command') {
            pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, getPrimaryOtherTarget(tool))
    }

    return {
        totalTools: tools.length,
        countsByKind,
        fileTargets,
        commandTargets,
        searchTargets,
        urlTargets,
        otherTargets,
        errorCount,
        runningCount,
        pendingCount,
    }
}

function isInteractiveToolBlock(block: ToolCallBlock): boolean {
    const permission = block.tool.permission
    const hasTerminalPermissionReason = (
        permission?.status === 'denied' || permission?.status === 'canceled'
    ) && Boolean(permission.reason)

    return INTERACTIVE_TOOL_NAMES.has(normalizeToolIdentifier(block.tool.name))
        || permission?.status === 'pending'
        || hasTerminalPermissionReason
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

export function isEligibleForToolGrouping(block: ToolCallBlock, groupingMode: ToolGroupingMode = 'classified'): boolean {
    const normalizedName = normalizeToolIdentifier(block.tool.name)
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.has(normalizedName)) return false
    if (MILESTONE_TOOL_NAMES.has(normalizedName)) return false
    if (isInteractiveToolBlock(block)) return false
    if (groupingMode === 'classified' && block.tool.name === 'CodexBash' && getCodexCommandActions(block).length > 0) {
        return isCodexExplorationTool(block)
    }
    return true
}

function getGroupingFamily(block: ToolCallBlock, groupingMode: ToolGroupingMode): 'default' | 'codex-exploration' | null {
    if (!isEligibleForToolGrouping(block, groupingMode)) return null
    if (groupingMode === 'grouped') return 'default'
    return isCodexExplorationTool(block) ? 'codex-exploration' : null
}

function createToolGroupId(
    tools: ToolCallBlock[],
    needsOlderHistory: boolean,
    previousGroups: ToolGroupBlock[],
    groupingFamily: 'default' | 'codex-exploration'
): string {
    const firstToolId = tools[0]?.id ?? 'unknown'
    const lastToolId = tools[tools.length - 1]?.id ?? firstToolId

    const previous = previousGroups.find((group) => group.firstToolId === firstToolId || group.lastToolId === lastToolId)
    if (previous) {
        return previous.id
    }

    const boundaryId = needsOlderHistory ? lastToolId : firstToolId
    return `tool-group:${groupingFamily}:${boundaryId}`
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

function appendToolGroup(
    visibleBlocks: VisibleChatBlock[],
    tools: ToolCallBlock[],
    groupingFamily: 'default' | 'codex-exploration',
    options: ToolGroupingOptions,
    previousGroups: ToolGroupBlock[]
): void {
    const startsAtOldestVisibleBoundary = visibleBlocks.length === 0
    const needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
    const previousBlock = visibleBlocks.at(-1)
    const activityTitle = previousBlock?.kind === 'tool-call'
        && previousBlock.tool.name === 'CodexReasoning'
        ? getInputStringAny(previousBlock.tool.input, ['title'])
        : null

    visibleBlocks.push({
        kind: 'tool-group',
        id: createToolGroupId(tools, needsOlderHistory, previousGroups, groupingFamily),
        createdAt: tools[0].createdAt,
        invokedAt: tools[0].invokedAt,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: groupingFamily === 'codex-exploration' && options.codexExplorationCollapsed === false,
        historyState: needsOlderHistory ? 'needs-older-history' : 'complete',
        needsOlderHistory,
        activityTitle,
        presentationMode: groupingFamily,
        summary: summarizeToolGroup(tools)
    })
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const groupingMode = options.groupingMode ?? 'classified'
    const previousGroups = options.previousGroupingMode == null || options.previousGroupingMode === groupingMode
        ? (options.previousGroups ?? [])
        : []

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]

        if (block.kind !== 'tool-call') {
            visibleBlocks.push(block)
            continue
        }
        const groupingFamily = getGroupingFamily(block, groupingMode)
        if (!groupingFamily) {
            visibleBlocks.push(block)
            continue
        }

        const tools: ToolCallBlock[] = [block]
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (candidate.kind !== 'tool-call' || getGroupingFamily(candidate, groupingMode) !== groupingFamily) {
                break
            }
            tools.push(candidate)
            cursor += 1
        }

        if (tools.length < 2 && groupingFamily !== 'codex-exploration') {
            visibleBlocks.push(block)
            continue
        }

        appendToolGroup(visibleBlocks, tools, groupingFamily, options, previousGroups)
        index = cursor - 1
    }

    return visibleBlocks
}
