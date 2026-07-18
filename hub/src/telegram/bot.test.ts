import { describe, expect, it, mock, spyOn } from 'bun:test'
import { HappyBot } from './bot'
import type { SyncEngine } from '../sync/syncEngine'
import type { Store, StoredUser } from '../store'
import type { AccessTokenBindingValidator } from '../utils/accessToken'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeStore(users: StoredUser[] = []): Store {
    return {
        users: {
            getUsersByPlatformAndNamespace: (platform: string, namespace: string) => users.filter(
                (user) => user.platform === platform && user.namespace === namespace,
            ),
            getUser: (platform: string, platformUserId: string) => users.find(
                (user) => user.platform === platform && user.platformUserId === platformUserId,
            ) ?? null,
        }
    } as unknown as Store
}

function createBot(
    users: StoredUser[] = [],
    isTelegramBindingCurrent: AccessTokenBindingValidator = () => true,
) {
    const bot = new HappyBot({
        syncEngine: {} as unknown as SyncEngine,
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        publicUrl: 'https://example.com',
        store: createFakeStore(users),
        isTelegramBindingCurrent,
    } as ConstructorParameters<typeof HappyBot>[0] & {
        isTelegramBindingCurrent: AccessTokenBindingValidator
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

describe('HappyBot Telegram binding authorization', () => {
    it('filters invalidated bindings from callbacks and notification recipients', () => {
        const users = [
            {
                id: 1,
                platform: 'telegram',
                platformUserId: '111',
                namespace: 'alice',
                credentialFingerprint: null,
                createdAt: 1,
            },
            {
                id: 2,
                platform: 'telegram',
                platformUserId: '222',
                namespace: 'alice',
                credentialFingerprint: 'current-fingerprint',
                createdAt: 2,
            },
        ] as unknown as StoredUser[]
        const bot = createBot(users, (user) => user.credentialFingerprint === 'current-fingerprint')
        const internal = bot as unknown as {
            getNamespaceForChatId(chatId: number): string | null
            getBoundChatIds(namespace: string): number[]
        }

        expect(internal.getNamespaceForChatId(111)).toBeNull()
        expect(internal.getNamespaceForChatId(222)).toBe('alice')
        expect(internal.getBoundChatIds('alice')).toEqual([222])
    })
})
