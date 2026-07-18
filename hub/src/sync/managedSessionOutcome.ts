import type { ManagedResumeOperation, ManagedSessionStore } from '../store/managedSessionStore'

export type ManagedResumeContext = {
    reusedSpawnRequestId: boolean
    resumeOperation: ManagedResumeOperation | null
    bindResumeOperation: (operation: ManagedResumeOperation) => ManagedResumeOperation
}

export class ManagedSessionOutcomeService {
    private readonly inFlight = new Map<string, Promise<string>>()

    constructor(
        private readonly store: ManagedSessionStore,
        private readonly leaseMs: number = 30_000
    ) {}

    async resumeCanonical(
        namespace: string,
        sessionId: string,
        resume: (spawnRequestId: string, context: ManagedResumeContext) => Promise<string>
    ): Promise<string> {
        const canonical = this.store.resolveCanonical(namespace, sessionId)
        const key = `${namespace}:${canonical}`
        const existing = this.inFlight.get(key)
        if (existing) return existing

        const operation = this.runWithLease(namespace, canonical, resume)
        this.inFlight.set(key, operation)
        try {
            return await operation
        } finally {
            if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
        }
    }

    private async runWithLease(
        namespace: string,
        canonical: string,
        resume: (spawnRequestId: string, context: ManagedResumeContext) => Promise<string>
    ): Promise<string> {
        const ownerToken = this.store.newLeaseToken()
        const proposedSpawnRequestId = this.store.newLeaseToken()
        const deadline = Date.now() + Math.max(30_000, this.leaseMs * 4)
        for (;;) {
            const lease = this.store.tryAcquireResumeLease(
                namespace,
                canonical,
                ownerToken,
                this.leaseMs,
                proposedSpawnRequestId
            )
            if (lease.status === 'complete') return lease.resultSessionId!
            if (lease.status === 'ambiguous') {
                throw new Error('Legacy in-flight resume has no durable spawn request ID; wait for session reconciliation before retrying')
            }
            if (lease.status === 'acquired') {
                let leaseLost = false
                let spawnMayExist = false
                const renewal = setInterval(() => {
                    if (!this.store.renewResumeLease(namespace, canonical, ownerToken, this.leaseMs)) {
                        leaseLost = true
                    }
                }, Math.max(5, Math.floor(this.leaseMs / 3)))
                renewal.unref()
                try {
                    const result = await resume(lease.spawnRequestId, {
                        reusedSpawnRequestId: lease.reusedSpawnRequestId,
                        resumeOperation: lease.resumeOperation,
                        bindResumeOperation: (operation) => this.store.bindResumeLeaseOperation(
                            namespace,
                            canonical,
                            ownerToken,
                            lease.spawnRequestId,
                            operation
                        )
                    })
                    spawnMayExist = true
                    if (leaseLost) throw new Error('canonical resume lease was lost during native resume')
                    this.store.completeResumeLease(namespace, canonical, ownerToken, result)
                    return result
                } catch (error) {
                    const preserveSpawnRequest = spawnMayExist || (
                        typeof error === 'object'
                        && error !== null
                        && 'preserveSpawnRequest' in error
                        && error.preserveSpawnRequest === true
                    )
                    if (preserveSpawnRequest) {
                        this.store.abandonResumeLease(namespace, canonical, ownerToken)
                    } else {
                        this.store.releaseResumeLease(namespace, canonical, ownerToken)
                    }
                    throw error
                } finally {
                    clearInterval(renewal)
                }
            }
            if (Date.now() >= deadline) throw new Error('timed out waiting for canonical resume lease')
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
    }
}
