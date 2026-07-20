import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import type { HostOperationSnapshot } from '@hapi/protocol'

type OperationDomain = HostOperationSnapshot['domain']
type OperationResult = Record<string, unknown> | void

export type HostOperationContext = {
    signal: AbortSignal
    report: (progress: number, message?: string) => void
}

function normalizedPath(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
}

function containsPath(parent: string, candidate: string): boolean {
    const rel = relative(normalizedPath(parent), normalizedPath(candidate))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function lockKeysOverlap(left: string, right: string): boolean {
    return containsPath(left, right) || containsPath(right, left)
}

export class HostOperationManager {
    private readonly operations = new Map<string, HostOperationSnapshot>()
    private readonly controllers = new Map<string, AbortController>()
    private readonly locks = new Map<string, string>()

    start(options: {
        domain: OperationDomain
        kind: string
        lockKeys?: string[]
        run: (context: HostOperationContext) => Promise<OperationResult>
    }): HostOperationSnapshot {
        const lockKeys = Array.from(new Set(options.lockKeys ?? []))
        const activeKeys = [...this.locks.keys()]
        const conflictingKey = lockKeys.find((key) => activeKeys.some((active) => lockKeysOverlap(key, active)))
        if (conflictingKey) {
            throw new Error('Another operation is already modifying this location')
        }

        const id = randomUUID()
        const now = Date.now()
        const snapshot: HostOperationSnapshot = {
            id,
            domain: options.domain,
            kind: options.kind,
            status: 'queued',
            progress: 0,
            createdAt: now
        }
        const controller = new AbortController()
        this.operations.set(id, snapshot)
        this.controllers.set(id, controller)
        for (const key of lockKeys) this.locks.set(key, id)

        setTimeout(() => {
            void this.run(id, lockKeys, controller, options.run)
        }, 0)

        return { ...snapshot }
    }

    get(id: string): HostOperationSnapshot | null {
        const operation = this.operations.get(id)
        return operation ? { ...operation } : null
    }

    cancel(id: string): HostOperationSnapshot | null {
        const operation = this.operations.get(id)
        if (!operation) return null
        if (operation.status === 'queued' || operation.status === 'running') {
            this.controllers.get(id)?.abort()
        }
        return { ...operation }
    }

    private async run(
        id: string,
        lockKeys: string[],
        controller: AbortController,
        run: (context: HostOperationContext) => Promise<OperationResult>
    ): Promise<void> {
        const operation = this.operations.get(id)
        if (!operation) return
        if (controller.signal.aborted) {
            operation.status = 'cancelled'
            operation.message = 'Operation cancelled'
            operation.finishedAt = Date.now()
            this.finish(id, lockKeys)
            return
        }
        operation.status = 'running'
        operation.startedAt = Date.now()

        const report = (progress: number, message?: string) => {
            const current = this.operations.get(id)
            if (!current || current.status !== 'running') return
            current.progress = Math.max(0, Math.min(1, progress))
            current.message = message
        }

        try {
            const result = await run({ signal: controller.signal, report })
            if (controller.signal.aborted) {
                operation.status = 'cancelled'
                operation.message = 'Operation cancelled'
            } else {
                operation.status = 'succeeded'
                operation.progress = 1
                operation.result = result || undefined
            }
        } catch (error) {
            if (controller.signal.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
                operation.status = 'cancelled'
                operation.message = 'Operation cancelled'
            } else {
                operation.status = 'failed'
                operation.error = error instanceof Error ? error.message : 'Operation failed'
            }
        } finally {
            operation.finishedAt = Date.now()
            this.finish(id, lockKeys)
        }
    }

    private finish(id: string, lockKeys: string[]): void {
        this.controllers.delete(id)
        for (const key of lockKeys) {
            if (this.locks.get(key) === id) this.locks.delete(key)
        }
        const retentionTimer = setTimeout(() => this.operations.delete(id), 30 * 60 * 1000)
        retentionTimer.unref()
    }
}
