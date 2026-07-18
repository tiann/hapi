import type { DeliveryAttemptRequest, DeliveryAttemptState } from '@hapi/protocol'

type DeliveryItem = { messageId: string; sequence: number }

type DeliveryOutcomeClientOptions = {
    namespace: string
    machineId: string
    sessionId: string
    launchNonce: string
    record: (request: DeliveryAttemptRequest) => Promise<boolean>
    prepare?: (requests: Array<Omit<DeliveryAttemptRequest, 'state'>>) => Promise<'success' | 'definitive-no-write' | 'ambiguous'>
}

export class DeliveryOutcomeClient {
    constructor(private readonly options: DeliveryOutcomeClientOptions) {}

    async deliverBatch(
        items: DeliveryItem[],
        attemptId: string,
        transport: () => Promise<void>
    ): Promise<{ delivered: true } | { delivered: false; reason: 'definitive-no-write' | 'ambiguous-barrier' | 'ambiguous-transport' }> {
        const barrier = await this.prepareBatch(items, attemptId)
        if (!barrier.written) return { delivered: false, reason: barrier.reason }
        try {
            await transport()
            return { delivered: true }
        } catch {
            await Promise.allSettled(items.map((entry) => this.record(entry, attemptId, 'ambiguous')))
            return { delivered: false, reason: 'ambiguous-transport' }
        }
    }

    async prepareBatch(
        items: DeliveryItem[],
        attemptId: string
    ): Promise<{ written: true } | { written: false; reason: 'definitive-no-write' | 'ambiguous-barrier' }> {
        if (this.options.prepare) {
            const createdAt = Date.now()
            const prepared = await this.options.prepare(items.map((item) => ({
                idempotencyKey: `${attemptId}:${item.messageId}:batch`,
                namespace: this.options.namespace,
                machineId: this.options.machineId,
                sessionId: this.options.sessionId,
                messageId: item.messageId,
                sequence: item.sequence,
                attemptId,
                launchNonce: this.options.launchNonce,
                createdAt
            })))
            if (prepared === 'success') return { written: true }
            return { written: false, reason: prepared === 'ambiguous' ? 'ambiguous-barrier' : 'definitive-no-write' }
        }
        const prepared: DeliveryItem[] = []
        for (const item of items) {
            if (!await this.record(item, attemptId, 'prepared')) {
                await Promise.allSettled(prepared.map((entry) => this.record(entry, attemptId, 'definitive-no-write')))
                return { written: false, reason: 'definitive-no-write' }
            }
            prepared.push(item)
        }

        for (const item of items) {
            if (!await this.record(item, attemptId, 'written')) {
                await Promise.allSettled(items.map((entry) => this.record(entry, attemptId, 'ambiguous')))
                return { written: false, reason: 'ambiguous-barrier' }
            }
        }

        return { written: true }
    }

    async recordTerminal(items: DeliveryItem[], attemptId: string, state: Extract<DeliveryAttemptState, 'accepted' | 'definitive-rejected' | 'definitive-no-write' | 'ambiguous' | 'canceled' | 'superseded'>): Promise<boolean> {
        const results = await Promise.all(items.map((item) => this.record(item, attemptId, state)))
        return results.every(Boolean)
    }

    private async record(item: DeliveryItem, attemptId: string, state: DeliveryAttemptState): Promise<boolean> {
        return this.options.record({
            idempotencyKey: `${attemptId}:${item.messageId}:${state}`,
            namespace: this.options.namespace,
            machineId: this.options.machineId,
            sessionId: this.options.sessionId,
            messageId: item.messageId,
            sequence: item.sequence,
            attemptId,
            launchNonce: this.options.launchNonce,
            state,
            createdAt: Date.now()
        })
    }
}
