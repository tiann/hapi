import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { BaseLocalLauncher, type LocalLauncherOptions } from './BaseLocalLauncher'

function createLauncher(queue: MessageQueue2<string>) {
    const handlers = new Map<string, () => Promise<void>>()
    const launch = vi.fn(async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
        })
    })
    const options = {
        label: 'test-local',
        failureLabel: 'test-local failed',
        queue: queue as unknown as LocalLauncherOptions['queue'],
        rpcHandlerManager: {
            registerHandler: (method: string, handler: () => Promise<void>) => {
                handlers.set(method, handler)
            }
        } as unknown as LocalLauncherOptions['rpcHandlerManager'],
        launch,
        sendFailureMessage: vi.fn(),
        recordLocalLaunchFailure: vi.fn()
    }
    const launcher = new BaseLocalLauncher(options)
    return { launcher, handlers, launch }
}

async function startedLauncher(queue: MessageQueue2<string>) {
    const { launcher, handlers, launch } = createLauncher(queue)
    const runPromise = launcher.run()
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    return { launcher, handlers, launch, runPromise }
}

describe('BaseLocalLauncher Abort queue preservation', () => {
    it('keeps pending queued messages with localIds/order/mode intact across Abort (switch to remote)', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        const { handlers, runPromise } = await startedLauncher(queue)

        queue.push('A', 'mode-a', 'id-a')
        queue.push('B', 'mode-a', 'id-b')

        const abort = handlers.get(RPC_METHODS.Abort)
        expect(abort).toBeDefined()
        await abort!()
        await runPromise

        expect(queue.size()).toBe(2)
        expect(queue.pendingLocalIds()).toEqual(['id-a', 'id-b'])
        const first = await queue.waitForMessagesAndGetAsString()
        expect(first?.items).toEqual([{ message: 'A', localId: 'id-a' }, { message: 'B', localId: 'id-b' }])
    })

    it('preserves the queue across repeated Abort', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        const { handlers, runPromise } = await startedLauncher(queue)

        queue.push('A', 'mode-a', 'id-a')

        const abort = handlers.get(RPC_METHODS.Abort)!
        await abort()
        await abort()
        await runPromise

        expect(queue.pendingLocalIds()).toEqual(['id-a'])
    })

    it('preserves the queue across exit (control: exit never reset the queue)', async () => {
        const queue = new MessageQueue2<string>((mode) => mode)
        const { launcher, runPromise } = await startedLauncher(queue)

        queue.push('A', 'mode-a', 'id-a')
        launcher.control.requestExit()
        await runPromise

        expect(queue.pendingLocalIds()).toEqual(['id-a'])
    })
})
