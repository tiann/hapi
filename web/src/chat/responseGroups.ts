import { isObject } from '@hapi/protocol'
import type { ChatBlock, RoundSummary } from './types'
import { visibleBlockRole } from './toolGroups'

export type AssistantResponseGroup = {
    blocks: Exclude<ChatBlock, { kind: 'user-text' | 'agent-event' }>[]
    before: ChatBlock | null
    after: ChatBlock | null
}

// Use the original runtime boundaries, including events hidden by projection.
export function getAssistantResponseGroups(blocks: readonly ChatBlock[]): AssistantResponseGroup[] {
    const groups: AssistantResponseGroup[] = []
    let group: AssistantResponseGroup | null = null
    let before: ChatBlock | null = null
    for (const block of blocks) {
        if (block.kind !== 'user-text' && block.kind !== 'agent-event' && visibleBlockRole(block) === 'assistant') {
            group ??= { blocks: [], before, after: null }
            group.blocks.push(block)
        } else {
            if (group) { group.after = block; groups.push(group); group = null }
            before = block
        }
    }
    if (group) groups.push(group)
    return groups
}

export function hasUnambiguousResponseOwner(group: AssistantResponseGroup): boolean {
    const owners = new Set(group.blocks.map(block => isObject(block.meta) && typeof block.meta.codexTurnId === 'string'
        ? block.meta.codexTurnId : undefined))
    const summaries: RoundSummary[] = group.blocks.flatMap(block => block.roundSummary ? [block.roundSummary] : [])
    return owners.size === 1 && summaries.length <= 1
        && summaries.every(summary => !summary.turnId || owners.has(summary.turnId))
}

export function responseBlockKey(block: ChatBlock): string {
    return `${block.kind}:${block.id}`
}

// Stable source identity, not presentation text, summary values or local indices.
export function responseBlockIdentity(block: ChatBlock): unknown {
    return [responseBlockKey(block), 'localId' in block ? block.localId : null,
        block.invokedAt, block.kind === 'agent-event' ? block.event.type : null,
        'sourceMessageIds' in block ? block.sourceMessageIds : null,
        isObject(block.meta) ? block.meta.codexTurnId : null]
}

export function responseGroupIdentity(group: AssistantResponseGroup): string {
    return JSON.stringify([group.before && responseBlockIdentity(group.before),
        group.blocks.map(responseBlockIdentity), group.after && responseBlockIdentity(group.after)])
}
