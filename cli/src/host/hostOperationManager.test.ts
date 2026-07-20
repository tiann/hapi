import { describe, expect, it } from 'vitest'
import { HostOperationManager } from './hostOperationManager'

async function waitForFinish(manager: HostOperationManager, id: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const operation = manager.get(id)
        if (operation && ['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Operation did not finish')
}

describe('HostOperationManager', () => {
    it('runs jobs, reports progress, and releases path locks', async () => {
        const manager = new HostOperationManager()
        const first = manager.start({
            domain: 'file',
            kind: 'copy',
            lockKeys: ['/workspace/a'],
            run: async ({ report }) => {
                report(0.5, 'halfway')
                return { path: '/workspace/a' }
            }
        })
        expect(() => manager.start({ domain: 'file', kind: 'move', lockKeys: ['/workspace/a'], run: async () => {} })).toThrow(/already modifying/)
        expect(await waitForFinish(manager, first.id)).toMatchObject({ status: 'succeeded', progress: 1, result: { path: '/workspace/a' } })
        expect(() => manager.start({ domain: 'file', kind: 'move', lockKeys: ['/workspace/a'], run: async () => {} })).not.toThrow()
    })

    it('treats parent and child paths as conflicting locks', async () => {
        const manager = new HostOperationManager()
        const first = manager.start({
            domain: 'file',
            kind: 'delete',
            lockKeys: ['/workspace/project'],
            run: async ({ signal }) => {
                while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
            }
        })

        expect(() => manager.start({
            domain: 'file',
            kind: 'create-file',
            lockKeys: ['/workspace/project/..cache'],
            run: async () => {}
        })).toThrow(/already modifying/)
        manager.cancel(first.id)
        await waitForFinish(manager, first.id)
    })

    it('cancels running jobs', async () => {
        const manager = new HostOperationManager()
        const operation = manager.start({
            domain: 'git',
            kind: 'clone',
            run: async ({ signal }) => {
                while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
            }
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        manager.cancel(operation.id)
        expect(await waitForFinish(manager, operation.id)).toMatchObject({ status: 'cancelled' })
    })

    it('does not start a queued job after cancellation', async () => {
        const manager = new HostOperationManager()
        let ran = false
        const operation = manager.start({
            domain: 'file',
            kind: 'create-file',
            run: async () => { ran = true }
        })
        manager.cancel(operation.id)

        expect(await waitForFinish(manager, operation.id)).toMatchObject({ status: 'cancelled' })
        expect(ran).toBe(false)
    })
})
