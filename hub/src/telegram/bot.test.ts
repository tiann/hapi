import { describe, expect, it, mock, spyOn } from 'bun:test'
import { HappyBot } from './bot'
import type { SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeStore(): Store {
    return {
        users: {
            getUsersByPlatformAndNamespace: () => [],
            getUser: () => null
        }
    } as unknown as Store
}

function createBot() {
    const bot = new HappyBot({
        syncEngine: {} as unknown as SyncEngine,
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        publicUrl: 'https://example.com',
        store: createFakeStore()
    })
    return bot
}

describe('HappyBot.start', () => {
    it('logs error and resets isRunning when polling fails', async () => {
        const bot = createBot()
        const innerBot = bot.getBot()

        // Override bot.start to simulate a polling failure
        innerBot.start = mock((): Promise<void> => Promise.reject(new Error('Network failure')))

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

        await bot.start()
        // Allow microtask (.catch handler) to run
        await sleep(10)

        expect(errorSpy).toHaveBeenCalledWith(
            '[HAPIBot] Telegram bot polling failed:',
            'Network failure'
        )

        // isRunning should be reset, so start() should work again
        await bot.start()
        expect(innerBot.start).toHaveBeenCalledTimes(2)

        errorSpy.mockRestore()
    })

    it('does not call bot.start twice when already running', async () => {
        const bot = createBot()
        const innerBot = bot.getBot()

        // Simulate a long-running polling that never resolves
        innerBot.start = mock((): Promise<void> => new Promise(() => {}))

        await bot.start()
        await bot.start() // second call should be no-op

        expect(innerBot.start).toHaveBeenCalledTimes(1)
    })
})
