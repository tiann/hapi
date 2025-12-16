import type { NormalizedMessage } from '@/chat/types'

export type TracedMessage = NormalizedMessage & {
    sidechainId?: string
}

type TracerState = {
    promptToTaskId: Map<string, string>
    uuidToSidechainId: Map<string, string>
    orphanMessages: Map<string, NormalizedMessage[]>
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const first = message.content[0] as unknown as Record<string, unknown>
        return typeof first.uuid === 'string' ? first.uuid : null
    }
    return null
}

function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const first = message.content[0] as unknown as Record<string, unknown>
        return typeof first.parentUUID === 'string' ? first.parentUUID : null
    }
    return null
}

function processOrphans(state: TracerState, parentUuid: string, sidechainId: string): TracedMessage[] {
    const results: TracedMessage[] = []
    const orphans = state.orphanMessages.get(parentUuid)
    if (!orphans) return results
    state.orphanMessages.delete(parentUuid)

    for (const orphan of orphans) {
        const uuid = getMessageUuid(orphan)
        if (uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId)
        }

        results.push({ ...orphan, sidechainId })

        if (uuid) {
            results.push(...processOrphans(state, uuid, sidechainId))
        }
    }

    return results
}

export function traceMessages(messages: NormalizedMessage[]): TracedMessage[] {
    const state: TracerState = {
        promptToTaskId: new Map(),
        uuidToSidechainId: new Map(),
        orphanMessages: new Map()
    }

    const results: TracedMessage[] = []

    // Index Task prompts (including those inside sidechains).
    for (const message of messages) {
        if (message.role !== 'agent') continue
        for (const content of message.content) {
            if (content.type !== 'tool-call' || content.name !== 'Task') continue
            const input = content.input
            if (!isObject(input) || typeof input.prompt !== 'string') continue
            state.promptToTaskId.set(input.prompt, message.id)
        }
    }

    for (const message of messages) {
        if (!message.isSidechain) {
            results.push({ ...message })
            continue
        }

        const uuid = getMessageUuid(message)
        const parentUuid = getParentUuid(message)

        // Sidechain root matching (prompt == Task.prompt).
        let sidechainId: string | undefined
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type !== 'sidechain') continue
                const taskId = state.promptToTaskId.get(content.prompt)
                if (taskId) {
                    sidechainId = taskId
                    break
                }
            }
        }

        if (sidechainId && uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId)
            results.push({ ...message, sidechainId })
            results.push(...processOrphans(state, uuid, sidechainId))
            continue
        }

        if (parentUuid) {
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid)
            if (parentSidechainId) {
                if (uuid) {
                    state.uuidToSidechainId.set(uuid, parentSidechainId)
                }
                results.push({ ...message, sidechainId: parentSidechainId })
                if (uuid) {
                    results.push(...processOrphans(state, uuid, parentSidechainId))
                }
            } else {
                const orphans = state.orphanMessages.get(parentUuid) ?? []
                orphans.push(message)
                state.orphanMessages.set(parentUuid, orphans)
            }
            continue
        }

        results.push({ ...message })
    }

    return results
}

