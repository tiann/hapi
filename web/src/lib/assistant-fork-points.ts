import type { ChatBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { buildVisibleChatBlocks, visibleBlockRole } from '@/chat/toolGroups'
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

/** Fork points must be resolved against the canonical thread: the concise
 *  filter drops compact-summary/system/CLI boundaries, and scanning the
 *  filtered projection would bridge an assistant turn across them. Card ids
 *  are per-block (`kind:id`), so keys resolved here stay valid for the
 *  filtered render. */
export function resolveAssistantForkPointsForCanonicalBlocks(
    blocks: readonly ChatBlock[],
    visibleOptions: Parameters<typeof buildVisibleChatBlocks>[1],
    points: Record<string, true> | undefined
): Map<string, string> {
    return resolveAssistantForkPoints(buildVisibleChatBlocks([...blocks], visibleOptions), points)
}
