import type { DeliveryAttemptState } from '@hapi/protocol'
import type { MessageQueue2 } from '@/utils/MessageQueue2'

type TerminalState = Extract<DeliveryAttemptState, 'canceled' | 'superseded' | 'ambiguous'>
type DeliveryItem = { messageId: string; sequence: number }

export async function invalidateCodexQueueDurably<T>(options: {
    queue: MessageQueue2<T>
    reason: string
    state: TerminalState
    attemptId: string
    recordTerminal?: (items: DeliveryItem[], attemptId: string, state: TerminalState) => Promise<boolean>
    onAmbiguous?: () => void
}): Promise<void> {
    const failAmbiguous = (cause?: unknown): never => {
        options.onAmbiguous?.()
        throw new Error(`failed to durably ${options.state} queued messages`, cause === undefined ? undefined : { cause })
    }
    const recordedItems = new Map<string, { messageId: string; sequence: number }>()

    while (true) {
        const snapshot = options.queue.snapshotAll()
        const currentKeys = new Set(snapshot.map((item) => `${item.generation}:${item.id}`))
        if ([...recordedItems.keys()].some((key) => !currentKeys.has(key))) {
            failAmbiguous()
        }

        const pending = snapshot.filter((item) => !recordedItems.has(`${item.generation}:${item.id}`))
        if (options.recordTerminal && pending.length > 0) {
            const items = pending.map((item) => ({
                messageId: item.messageId,
                sequence: item.seq
            }))
            let recorded = false
            try {
                recorded = await options.recordTerminal(items, options.attemptId, options.state)
            } catch (error) {
                failAmbiguous(error)
            }
            if (!recorded) failAmbiguous()
            for (const item of pending) {
                recordedItems.set(`${item.generation}:${item.id}`, {
                    messageId: item.messageId,
                    sequence: item.seq
                })
            }
            continue
        }

        if (!options.queue.clearIfSnapshotMatches(snapshot)) {
            failAmbiguous()
        }
        return
    }
}
