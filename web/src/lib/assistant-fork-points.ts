import type { VisibleChatBlock } from '@/chat/toolGroups'
import { visibleBlockRole } from '@/chat/toolGroups'
import { assignThreadMessageIds } from '@/lib/assistant-runtime'

// Native historical forks exclude the selected user prompt. The next
// recorded user prompt therefore anchors a fork after an assistant turn.
export function resolveAssistantForkPoints(
    blocks: readonly VisibleChatBlock[],
    points: Record<string, true> | undefined
): Map<string, string> {
    const result = new Map<string, string>()
    let assistantId: string | null = null
    for (const { block, threadMessageId } of assignThreadMessageIds(blocks)) {
        if (block.kind === 'user-text') {
            if (assistantId && block.localId && points?.[block.localId] === true) {
                result.set(assistantId, block.localId)
            }
            assistantId = null
        } else if (visibleBlockRole(block) === 'assistant') {
            assistantId ??= threadMessageId
        } else {
            // Never bridge across unrepresented events or system boundaries.
            assistantId = null
        }
    }
    return result
}
