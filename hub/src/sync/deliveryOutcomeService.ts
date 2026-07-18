import type { DeliveryAttemptInput, DeliveryAttemptStore } from '../store/deliveryAttemptStore'

export class DeliveryOutcomeService {
    constructor(private readonly attempts: DeliveryAttemptStore) {}

    prepareBatch(inputs: Array<Omit<DeliveryAttemptInput, 'state'>>): { result: 'success' } | { result: 'error'; reason: 'invalid-transition' } {
        return this.attempts.prepareBatch(inputs)
    }

    record(input: DeliveryAttemptInput) {
        return this.attempts.append(input)
    }
}
