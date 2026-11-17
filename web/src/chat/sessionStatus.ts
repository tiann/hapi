import { isObject, type SessionLinkKind } from '@hapi/protocol'
import type { BackgroundTask, SessionSummary, ThreadGoal, TodoItem } from '@/types/api'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { hasUrgentModelError } from '@/components/ModelErrorBanner'
import { getCodexAgentActivity, getCodexAgentSummary } from '@/components/ToolCard/codexAgents'
import { extractSpawnedSessionId, parsePeerToolName, parseWrapperToolInvocation } from '@/components/ToolCard/peerTools'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

export type SessionStatusSubagent = {
    id: string
    blockId: string | null
    title: string
    detail: string | null
    state: 'running' | 'waiting' | 'error' | 'idle'
    startedAt: number | null
    endedAt: number | null
    linkedSessionId?: string | null
    nativeSessionId?: string | null
    linkKind?: SessionLinkKind | null
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

function isWrapperToolBlock(block: ToolCallBlock): boolean {
    return parseWrapperToolInvocation(
        block.tool.name,
        block.tool.input,
        block.tool.result,
        block.tool.nativeKind
    ) !== null
}

function findBackgroundLaunchBlock(
    tools: readonly ToolCallBlock[],
    task: BackgroundTask
): ToolCallBlock | undefined {
    if (task.type !== 'local_bash' || !task.id) return undefined
    const launch = backgroundLaunchPattern(task.id)
    return tools.find((tool) => tool.tool.name === 'Bash' && matchesText(tool.tool.result, launch))
}

function buildBackgroundTerminals(
    tools: readonly ToolCallBlock[],
    tasks: readonly BackgroundTask[]
): SessionStatusTerminal[] {
    const terminals: SessionStatusTerminal[] = []
    for (const task of tasks) {
        // Claude's snapshot carries the Bash description, not the command;
        // the tool result that started the task names its exact ID.
        const block = findBackgroundLaunchBlock(tools, task)
        if (block && isWrapperToolBlock(block)) continue
        terminals.push({
            id: task.id,
            command: (block && commandFromInput(block.tool.input)) || task.description || task.type,
            cwd: block ? getInputStringAny(block.tool.input, ['cwd', 'workdir', 'path']) : null,
            startedAt: block ? block.tool.startedAt ?? block.createdAt : null
        })
    }
    return terminals
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

function subagentFromBlock(
    block: ToolCallBlock,
    activeBackgroundWrapperBlockIds: ReadonlySet<string>
): SessionStatusSubagent | null {
    const isPeerSpawn = parsePeerToolName(block.tool.name) === 'spawn_peer'
    const wrapper = isPeerSpawn
        ? null
        : parseWrapperToolInvocation(block.tool.name, block.tool.input, block.tool.result, block.tool.nativeKind)
    if (block.tool.name !== 'CodexAgent' && !isSubagentToolName(block.tool.name) && !isPeerSpawn && !wrapper) return null
    const isActiveBackgroundWrapper = Boolean(wrapper) && activeBackgroundWrapperBlockIds.has(block.id)
    if (block.tool.state === 'completed' && !isActiveBackgroundWrapper) return null

    const latestChild = block.children.at(-1)
    const activity = isPeerSpawn
        ? getInputStringAny(block.tool.input, ['directory'])
        : wrapper
            ? wrapper.description
            : block.tool.name === 'CodexAgent'
                ? getCodexAgentActivity(block.tool.input)
                : latestChild?.kind === 'tool-call'
                    ? latestChild.tool.nativeTitle ?? latestChild.tool.name
                    : null
    const waiting = block.tool.state === 'pending'
        || (!isActiveBackgroundWrapper && (activity?.toLowerCase().startsWith('waiting') ?? false))
    const resolvedTitle = isPeerSpawn
        ? getInputStringAny(block.tool.input, ['name']) ?? subagentTitle(block)
        : wrapper
            ? wrapper.label
            : subagentTitle(block)

    return {
        id: block.tool.id,
        blockId: block.id,
        title: resolvedTitle,
        detail: activity,
        state: block.tool.state === 'error' ? 'error' : waiting ? 'waiting' : 'running',
        startedAt: block.tool.startedAt ?? (block.tool.state === 'pending' ? null : block.createdAt),
        endedAt: block.tool.state === 'error' && !isActiveBackgroundWrapper
            ? block.tool.completedAt ?? block.tool.startedAt ?? block.createdAt
            : null,
        ...(isPeerSpawn ? { linkedSessionId: extractSpawnedSessionId(block.tool.result) } : {}),
        ...(wrapper ? { nativeSessionId: wrapper.nativeSessionId } : {}),
    }
}

function classifyLinkedSessionState(session: SessionSummary): SessionStatusSubagent['state'] {
    if (hasUrgentModelError(session.metadata)) return 'error'
    if (session.active && (session.pendingRequestsCount ?? 0) > 0) return 'waiting'
    if ((session.active && session.thinking) || session.attachedJob?.status === 'running') return 'running'
    return 'idle'
}

function linkedSessionSortPriority(
    session: SessionSummary,
    state: SessionStatusSubagent['state']
): number {
    switch (state) {
        case 'error': return 0
        case 'waiting': return 1
        case 'running': return 2
        case 'idle': return session.active ? 3 : 4
    }
}

export function buildSessionStatusData(args: {
    sessionId?: string
    goal: ThreadGoal | null | undefined
    tasks: readonly TodoItem[] | null | undefined
    blocks: readonly ChatBlock[]
    backgroundTasks?: readonly BackgroundTask[]
    linkedSessions?: readonly SessionSummary[]
}): SessionStatusData | null {
    const tools = collectToolBlocks(args.blocks)
    const backgroundTasks = args.backgroundTasks ?? []
    const activeBackgroundWrapperBlockIds = new Set<string>()
    for (const task of backgroundTasks) {
        const launchBlock = findBackgroundLaunchBlock(tools, task)
        if (launchBlock && isWrapperToolBlock(launchBlock)) {
            activeBackgroundWrapperBlockIds.add(launchBlock.id)
        }
    }

    const subagents: SessionStatusSubagent[] = tools
        .map((block) => subagentFromBlock(block, activeBackgroundWrapperBlockIds))
        .filter((subagent): subagent is SessionStatusSubagent => subagent !== null)

    if (args.linkedSessions && args.linkedSessions.length > 0) {
        const byId = new Map<string, SessionSummary>()
        const byNativeId = new Map<string, SessionSummary>()
        for (const candidate of args.linkedSessions) {
            if (args.sessionId && candidate.id === args.sessionId) continue
            byId.set(candidate.id, candidate)
            const nativeId = candidate.metadata?.agentSessionId?.trim()
            if (nativeId && !byNativeId.has(nativeId)) {
                byNativeId.set(nativeId, candidate)
            }
        }

        const coveredSessionIds = new Set<string>()
        for (const subagent of subagents) {
            const matched = (subagent.linkedSessionId ? byId.get(subagent.linkedSessionId) : undefined)
                ?? (subagent.nativeSessionId ? byNativeId.get(subagent.nativeSessionId) : undefined)
            if (!matched) continue
            subagent.linkedSessionId = matched.id
            subagent.linkKind = matched.metadata?.parentLink?.kind ?? subagent.linkKind ?? 'peer'
            coveredSessionIds.add(matched.id)
        }

        if (args.sessionId) {
            const extraChildren = args.linkedSessions
                .filter((candidate) => candidate.id !== args.sessionId
                    && candidate.metadata?.parentLink?.parentSessionId === args.sessionId
                    && !coveredSessionIds.has(candidate.id))
                .map((session) => {
                    const state = classifyLinkedSessionState(session)
                    return {
                        session,
                        state,
                        priority: linkedSessionSortPriority(session, state),
                    }
                })
            extraChildren.sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority
                return b.session.updatedAt - a.session.updatedAt
            })
            for (const { session, state } of extraChildren) {
                const kind = session.metadata?.parentLink?.kind ?? 'peer'
                subagents.push({
                    id: `session:${session.id}`,
                    blockId: null,
                    title: getSessionTitle(session),
                    detail: session.metadata?.flavor?.trim() || null,
                    state,
                    startedAt: null,
                    endedAt: null,
                    linkedSessionId: session.id,
                    linkKind: kind,
                })
            }
        }
    }

    const data: SessionStatusData = {
        goal: args.goal ?? null,
        tasks: args.tasks ? [...args.tasks] : [],
        subagents,
        terminals: buildBackgroundTerminals(tools, backgroundTasks)
    }

    return data.goal
        || data.tasks.length > 0
        || data.subagents.length > 0
        || data.terminals.length > 0
        ? data
        : null
}
