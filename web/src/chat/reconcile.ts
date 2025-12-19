import type {
    AgentEvent,
    AgentEventBlock,
    AgentTextBlock,
    ChatBlock,
    ToolCallBlock,
    ToolPermission,
    UserTextBlock,
} from '@/chat/types'

export type ChatBlocksById = Map<string, ChatBlock>

function indexBlocks(blocks: ChatBlock[], map: ChatBlocksById): void {
    for (const block of blocks) {
        map.set(block.id, block)
        if (block.kind === 'tool-call') {
            indexBlocks(block.children, map)
        }
    }
}

function areStringArraysEqual(left?: string[] | null, right?: string[] | null): boolean {
    if (left === right) return true
    if (!left || !right) return false
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false
    }
    return true
}

function areAnswersEqual(
    left?: Record<string, string[]> | null,
    right?: Record<string, string[]> | null
): boolean {
    if (left === right) return true
    if (!left || !right) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    leftKeys.sort()
    rightKeys.sort()
    for (let i = 0; i < leftKeys.length; i += 1) {
        const leftKey = leftKeys[i]
        if (leftKey !== rightKeys[i]) return false
        if (!areStringArraysEqual(left[leftKey], right[leftKey])) return false
    }
    return true
}

function arePermissionsEqual(left?: ToolPermission, right?: ToolPermission): boolean {
    if (left === right) return true
    if (!left || !right) return false
    return left.id === right.id
        && left.status === right.status
        && left.reason === right.reason
        && left.mode === right.mode
        && left.decision === right.decision
        && left.date === right.date
        && left.createdAt === right.createdAt
        && left.completedAt === right.completedAt
        && areStringArraysEqual(left.allowedTools, right.allowedTools)
        && areAnswersEqual(left.answers, right.answers)
}

function getEventKey(event: AgentEvent): string {
    switch (event.type) {
        case 'switch':
            return `switch:${event.mode}`
        case 'message':
            return `message:${event.message}`
        case 'title-changed':
            return `title:${event.title}`
        case 'limit-reached':
            return `limit:${event.endsAt}`
        case 'ready':
            return 'ready'
        default:
            try {
                return JSON.stringify(event)
            } catch {
                return event.type
            }
    }
}

function areAgentEventsEqual(left: AgentEvent, right: AgentEvent): boolean {
    if (left === right) return true
    return getEventKey(left) === getEventKey(right)
}

function areUserTextBlocksEqual(left: UserTextBlock, right: UserTextBlock): boolean {
    return left.text === right.text
        && left.status === right.status
        && left.originalText === right.originalText
        && left.localId === right.localId
        && left.createdAt === right.createdAt
        && left.meta === right.meta
}

function areAgentTextBlocksEqual(left: AgentTextBlock, right: AgentTextBlock): boolean {
    return left.text === right.text
        && left.localId === right.localId
        && left.createdAt === right.createdAt
        && left.meta === right.meta
}

function areAgentEventBlocksEqual(left: AgentEventBlock, right: AgentEventBlock): boolean {
    return left.createdAt === right.createdAt
        && left.meta === right.meta
        && areAgentEventsEqual(left.event, right.event)
}

function areToolCallsEqual(left: ToolCallBlock, right: ToolCallBlock, childrenSame: boolean): boolean {
    if (!childrenSame) return false
    return left.localId === right.localId
        && left.createdAt === right.createdAt
        && left.meta === right.meta
        && left.tool.id === right.tool.id
        && left.tool.name === right.tool.name
        && left.tool.state === right.tool.state
        && left.tool.input === right.tool.input
        && left.tool.result === right.tool.result
        && left.tool.description === right.tool.description
        && left.tool.createdAt === right.tool.createdAt
        && left.tool.startedAt === right.tool.startedAt
        && left.tool.completedAt === right.tool.completedAt
        && arePermissionsEqual(left.tool.permission, right.tool.permission)
}

function reconcileBlockList(blocks: ChatBlock[], prevById: ChatBlocksById): ChatBlock[] {
    let changed = false
    const reconciled = blocks.map((block) => {
        const next = reconcileBlock(block, prevById)
        if (next !== block) {
            changed = true
        }
        return next
    })
    return changed ? reconciled : blocks
}

function reconcileBlock(block: ChatBlock, prevById: ChatBlocksById): ChatBlock {
    const prev = prevById.get(block.id)

    if (block.kind === 'tool-call') {
        const nextChildren = reconcileBlockList(block.children, prevById)
        const nextBlock = nextChildren === block.children
            ? block
            : { ...block, children: nextChildren }

        if (prev && prev.kind === 'tool-call') {
            const childrenSame = prev.children.length === nextChildren.length
                && prev.children.every((child, idx) => child === nextChildren[idx])
            if (areToolCallsEqual(prev, nextBlock, childrenSame)) {
                return prev
            }
        }
        return nextBlock
    }

    if (!prev || prev.kind !== block.kind) {
        return block
    }

    if (block.kind === 'user-text') {
        const prevBlock = prev as UserTextBlock
        return areUserTextBlocksEqual(prevBlock, block) ? prevBlock : block
    }

    if (block.kind === 'agent-text') {
        const prevBlock = prev as AgentTextBlock
        return areAgentTextBlocksEqual(prevBlock, block) ? prevBlock : block
    }

    const prevBlock = prev as AgentEventBlock
    return areAgentEventBlocksEqual(prevBlock, block) ? prevBlock : block
}

export function reconcileChatBlocks(nextBlocks: ChatBlock[], prevById: ChatBlocksById): {
    blocks: ChatBlock[]
    byId: ChatBlocksById
} {
    const blocks = reconcileBlockList(nextBlocks, prevById)
    const byId: ChatBlocksById = new Map()
    indexBlocks(blocks, byId)
    return { blocks, byId }
}
