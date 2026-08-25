import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import type { NormalizedMessage } from '@/chat/types'
import type { FixtureExpected, FixtureInput } from './fixtureTypes'
import { projectChatBlock, projectLatestUsage, projectVisibleChatBlock } from './projection'

/**
 * The exact pipeline a client must implement for chat rendering:
 * normalize → reduce → group, then the normative projection. This module is
 * shared by the generator and the self-conformance vitest so the two can
 * never diverge.
 */
export function runFixturePipeline(input: FixtureInput): FixtureExpected {
    const normalized = input.messages
        .map((message) => normalizeDecryptedMessage(message))
        .filter((message): message is NormalizedMessage => message !== null)
    const reduced = reduceChatBlocks(normalized, input.agentState)
    const visibleBlocks = buildVisibleChatBlocks(reduced.blocks, {
        hasMoreMessages: input.options.hasMoreMessages
    })
    return {
        blocks: reduced.blocks.map(projectChatBlock),
        hasReadyEvent: reduced.hasReadyEvent,
        latestUsage: projectLatestUsage(reduced.latestUsage),
        visibleBlocks: visibleBlocks.map(projectVisibleChatBlock)
    }
}
