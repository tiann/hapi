import { isObject } from '@hapi/protocol'
import type { BackgroundTask, ThreadGoal, TodoItem } from '@/types/api'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { getCodexAgentActivity, getCodexAgentSummary } from '@/components/ToolCard/codexAgents'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

export type SessionStatusSubagent = {
    id: string
    title: string
    detail: string | null
    state: 'running' | 'waiting' | 'error'
    startedAt: number | null
    endedAt: number | null
}

export type SessionStatusTerminal = {
    id: string
    command: string
    cwd: string | null
    startedAt: number | null
}

export type SessionStatusData = {
    goal: ThreadGoal | null
    tasks: TodoItem[]
    subagents: SessionStatusSubagent[]
    terminals: SessionStatusTerminal[]
}

function matchesText(value: unknown, pattern: RegExp): boolean {
    if (typeof value === 'string') return pattern.test(value)
    const values = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []
    return values.some((item) => matchesText(item, pattern))
}

// Matches "running in background with ID: <id>" and "moved to the background (ID: <id>)".
function backgroundLaunchPattern(taskId: string): RegExp {
    const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`background[^\\n]*\\bID: ${id}(?![\\w-])`)
}

function commandFromInput(input: unknown): string | null {
    const command = getInputStringAny(input, ['command', 'cmd'])
    if (command) return command
    if (!isObject(input) || !Array.isArray(input.command)) return null
    const parts = input.command.filter((part): part is string => typeof part === 'string')
    return parts.length > 0 ? parts.join(' ') : null
}

function collectToolBlocks(blocks: readonly ChatBlock[]): ToolCallBlock[] {
    const tools: ToolCallBlock[] = []
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        tools.push(block, ...collectToolBlocks(block.children))
    }
    return tools
}

function buildBackgroundTerminals(
    tools: readonly ToolCallBlock[],
    tasks: readonly BackgroundTask[]
): SessionStatusTerminal[] {
    return tasks.map((task) => {
        // Claude's snapshot carries the Bash description, not the command;
        // the tool result that started the task names its exact ID.
        const launch = task.type === 'local_bash' && task.id ? backgroundLaunchPattern(task.id) : null
        const block = launch
            ? tools.find((tool) => tool.tool.name === 'Bash' && matchesText(tool.tool.result, launch))
            : undefined
        return {
            id: task.id,
            command: (block && commandFromInput(block.tool.input)) || task.description || task.type,
            cwd: block ? getInputStringAny(block.tool.input, ['cwd', 'workdir', 'path']) : null,
            startedAt: block ? block.tool.startedAt ?? block.createdAt : null
        }
    })
}

function subagentTitle(block: ToolCallBlock): string {
    if (block.tool.name === 'CodexAgent') {
        return getCodexAgentSummary(block.tool.input) ?? 'Agent'
    }
    const explicit = getInputStringAny(block.tool.input, ['description', 'summary', 'title'])
    if (explicit) return truncate(explicit.replace(/\s+/g, ' ').trim(), 100)
    const prompt = getInputStringAny(block.tool.input, ['prompt', 'message'])
    if (prompt) return truncate(prompt.replace(/\s+/g, ' ').trim(), 100)
    return getInputStringAny(block.tool.input, ['subagent_type', 'agent_type']) ?? 'Agent'
}

function subagentFromBlock(block: ToolCallBlock): SessionStatusSubagent | null {
    if (block.tool.name !== 'CodexAgent' && !isSubagentToolName(block.tool.name)) return null
    if (block.tool.state === 'completed') return null

    const latestChild = block.children.at(-1)
    const activity = block.tool.name === 'CodexAgent'
        ? getCodexAgentActivity(block.tool.input)
        : latestChild?.kind === 'tool-call'
            ? latestChild.tool.nativeTitle ?? latestChild.tool.name
            : null
    const waiting = block.tool.state === 'pending'
        || (activity?.toLowerCase().startsWith('waiting') ?? false)

    return {
        id: block.tool.id,
        title: subagentTitle(block),
        detail: activity,
        state: block.tool.state === 'error' ? 'error' : waiting ? 'waiting' : 'running',
        startedAt: block.tool.startedAt ?? (block.tool.state === 'pending' ? null : block.createdAt),
        endedAt: block.tool.state === 'error'
            ? block.tool.completedAt ?? block.tool.startedAt ?? block.createdAt
            : null
    }
}

export function buildSessionStatusData(args: {
    goal: ThreadGoal | null | undefined
    tasks: readonly TodoItem[] | null | undefined
    blocks: readonly ChatBlock[]
    backgroundTasks?: readonly BackgroundTask[]
}): SessionStatusData | null {
    const tools = collectToolBlocks(args.blocks)
    const data: SessionStatusData = {
        goal: args.goal ?? null,
        tasks: args.tasks ? [...args.tasks] : [],
        subagents: tools
            .map(subagentFromBlock)
            .filter((subagent): subagent is SessionStatusSubagent => subagent !== null),
        terminals: buildBackgroundTerminals(tools, args.backgroundTasks ?? [])
    }

    return data.goal
        || data.tasks.length > 0
        || data.subagents.length > 0
        || data.terminals.length > 0
        ? data
        : null
}
