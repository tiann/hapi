import type { ChatBlock, ToolCallBlock } from '@/chat/types'

export const TOOL_GROUP_MIN_SIZE = 2

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    localId: string | null
    createdAt: number
    displayTimestamp?: number | null
    tools: ToolCallBlock[]
}

export type ToolDisplayBlock = ChatBlock | ToolGroupBlock

export function isToolGroupBlock(value: unknown): value is ToolGroupBlock {
    if (!value || typeof value !== 'object') return false
    const block = value as Partial<ToolGroupBlock>
    return block.kind === 'tool-group'
        && typeof block.id === 'string'
        && typeof block.createdAt === 'number'
        && Array.isArray(block.tools)
}

export function isGroupableToolBlock(block: ChatBlock): block is ToolCallBlock {
    if (block.kind !== 'tool-call') return false
    if (block.children.length > 0) return false
    if (block.tool.state === 'pending' || block.tool.state === 'error') return false

    const permissionStatus = block.tool.permission?.status
    if (permissionStatus === 'pending' || permissionStatus === 'denied' || permissionStatus === 'canceled') {
        return false
    }

    return true
}

function toToolGroup(tools: ToolCallBlock[]): ToolGroupBlock {
    const first = tools[0]
    return {
        kind: 'tool-group',
        id: `tool-group:${first.id}`,
        localId: null,
        createdAt: first.createdAt,
        displayTimestamp: first.displayTimestamp ?? null,
        tools
    }
}

export function groupConsecutiveToolBlocks(
    blocks: readonly ChatBlock[],
    minGroupSize: number = TOOL_GROUP_MIN_SIZE
): ToolDisplayBlock[] {
    const result: ToolDisplayBlock[] = []
    let run: ToolCallBlock[] = []

    const flushRun = () => {
        if (run.length === 0) return
        if (run.length >= minGroupSize) {
            result.push(toToolGroup(run))
        } else {
            result.push(...run)
        }
        run = []
    }

    for (const block of blocks) {
        if (isGroupableToolBlock(block)) {
            run.push(block)
            continue
        }

        flushRun()
        result.push(block)
    }

    flushRun()
    return result
}
