import type { AgentEvent, ChatBlock, ToolCallBlock } from '@/chat/types'
import { isInteractiveToolBlock } from '@/chat/toolGroups'
import { getAssistantResponseGroups, hasUnambiguousResponseOwner } from '@/chat/responseGroups'
import { getInputStringAny } from '@/lib/toolInputUtils'

// Plan proposals are decisions the user acts on, not intermediate work.
const PLAN_PROPOSAL_TOOL_NAMES = new Set([
    'exitplanmode',
    'cursorcreateplan'
])

function normalizeToolName(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isUserRoundBoundary(block: ChatBlock): boolean {
    return block.kind === 'user-text'
        || (block.kind === 'cli-output' && block.source === 'user')
}

function hasPendingPermission(block: ToolCallBlock): boolean {
    if (block.tool.permission?.status === 'pending') return true
    return block.children.some((child) => child.kind === 'tool-call' && hasPendingPermission(child))
}

function isConciseVisibleTool(block: ToolCallBlock): boolean {
    if (isInteractiveToolBlock(block)) return true
    if (PLAN_PROPOSAL_TOOL_NAMES.has(normalizeToolName(block.tool.name))) return true
    // User-initiated Codex shell commands are user input, not agent activity.
    if (getInputStringAny(block.tool.input, ['command_source', 'commandSource'])?.toLowerCase() === 'usershell') return true
    // A subagent waiting on approval must stay reachable from the main thread.
    return hasPendingPermission(block)
}

function isConciseVisibleEvent(event: AgentEvent): boolean {
    switch (event.type) {
        case 'error':
        case 'message':
        case 'limit-reached':
        case 'recap':
        case 'thread-goal-updated':
        case 'thread-goal-cleared':
            return true
        case 'api-error': {
            // Only the terminal failure matters; retries are transient noise.
            const { retryAttempt, maxRetries } = event as { retryAttempt?: number; maxRetries?: number }
            return typeof retryAttempt === 'number'
                && typeof maxRetries === 'number'
                && maxRetries > 0
                && retryAttempt >= maxRetries
        }
        default:
            return false
    }
}

// Projection must preserve metadata within the original runtime response group,
// even when a hidden event would otherwise join two visible assistant runs.
function preserveRoundSummaries(round: readonly ChatBlock[], output: ChatBlock[], start: number): void {
    const kept = new Map(output.slice(start).map((block, index) => [block, start + index]))
    for (const group of getAssistantResponseGroups(round)) {
        const sources = group.blocks.filter(block => block.roundSummary)
        // Never choose between carriers or invent a reply without a target.
        if (sources.length !== 1 || kept.has(sources[0]) || !hasUnambiguousResponseOwner(group)) continue
        const target = group.blocks.find(block => kept.has(block))
        if (target) output[kept.get(target)!] = { ...target, roundSummary: sources[0].roundSummary }
    }
}

function filterRound(round: readonly ChatBlock[], output: ChatBlock[]): void {
    // Agent text after the round's last tool call or reasoning is the reply;
    // text before it is narration of the work in progress.
    let lastWorkIndex = -1
    for (let index = round.length - 1; index >= 0; index -= 1) {
        const kind = round[index].kind
        if (kind === 'tool-call' || kind === 'agent-reasoning') {
            lastWorkIndex = index
            break
        }
    }

    const outputStart = output.length
    round.forEach((block, index) => {
        switch (block.kind) {
            case 'agent-text':
                if (index > lastWorkIndex) output.push(block)
                return
            case 'agent-reasoning':
                return
            case 'tool-call':
                if (isConciseVisibleTool(block)) output.push(block)
                return
            case 'agent-event':
                if (isConciseVisibleEvent(block.event)) output.push(block)
                return
            default:
                output.push(block)
        }
    })
    preserveRoundSummaries(round, output, outputStart)
}

/**
 * Concise view: keep what the user said and what the agent finally answered,
 * and drop the work in between (tool calls, reasoning, progress narration,
 * status events). Blocks that need the user's attention — pending
 * permissions, questions, plan proposals, errors — always stay visible.
 *
 * A round is everything between two user inputs; while a round is still
 * running, its latest trailing text reads as live progress and is replaced
 * once the agent moves on to the next tool call.
 */
export function filterConciseChatBlocks(blocks: readonly ChatBlock[]): ChatBlock[] {
    const output: ChatBlock[] = []
    let round: ChatBlock[] = []

    for (const block of blocks) {
        if (isUserRoundBoundary(block)) {
            filterRound(round, output)
            round = []
            output.push(block)
            continue
        }
        round.push(block)
    }
    filterRound(round, output)

    return output
}
