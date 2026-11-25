import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../store'
import {
    InputTranslationService,
    OpenAICompatibleTranslationProvider,
    needsTranslation,
    protectSpans,
    readTranslationProviderConfig,
    restoreSpans,
    type InputTranslationProvider
} from './inputTranslation'
import { MessageService } from './messageService'

describe('needsTranslation', () => {
    it('translates every prose message regardless of language', () => {
        expect(needsTranslation('帮我修复这个 bug')).toBe(true)
        expect(needsTranslation('Привет, исправь тест')).toBe(true)
        expect(needsTranslation('corrige le test, s\'il te plaît')).toBe(true)
        expect(needsTranslation('fix the failing test in hub/src')).toBe(true)
    })

    it('skips slash commands, empty or code-only input, and oversize prompts', () => {
        expect(needsTranslation('/compact 总结一下')).toBe(false)
        expect(needsTranslation('   ')).toBe(false)
        expect(needsTranslation('`变量` @src/a.ts')).toBe(false)
        expect(needsTranslation('x'.repeat(9_000))).toBe(false)
    })
})

describe('protectSpans / restoreSpans', () => {
    it('round-trips code, URLs and @mentions through placeholders', () => {
        const text = '看看 @src/a.ts 和 https://x.dev/中 以及 `foo()`\n```ts\nconst 中 = 1\n```'
        const { masked, spans } = protectSpans(text)
        expect(masked).toBe('看看 ⟦0⟧ 和 ⟦1⟧ 以及 ⟦2⟧\n⟦3⟧')
        expect(restoreSpans('Look at ⟦0⟧ and ⟦1⟧ and ⟦2⟧\n⟦3⟧', spans))
            .toBe('Look at @src/a.ts and https://x.dev/中 and `foo()`\n```ts\nconst 中 = 1\n```')
    })

    it('rejects dropped, duplicated, or invented placeholders', () => {
        const spans = ['`a`', '`b`']
        expect(restoreSpans('only ⟦0⟧', spans)).toBeNull()
        expect(restoreSpans('⟦0⟧ ⟦0⟧ ⟦1⟧', spans)).toBeNull()
        expect(restoreSpans('⟦0⟧ ⟦1⟧ ⟦2⟧', spans)).toBeNull()
    })
})

describe('readTranslationProviderConfig', () => {
    it('prefers dedicated settings and falls back to the title provider', () => {
        expect(readTranslationProviderConfig({
            HAPI_TRANSLATION_PROVIDER_BASE_URL: 'https://t.example/v1',
            HAPI_TRANSLATION_PROVIDER_API_KEY: 'tk',
            HAPI_TRANSLATION_PROVIDER_MODEL: 'tm',
            HAPI_TITLE_PROVIDER_BASE_URL: 'https://title.example/v1',
            HAPI_TITLE_PROVIDER_API_KEY: 'k',
            HAPI_TITLE_PROVIDER_MODEL: 'm'
        })).toMatchObject({ baseUrl: 'https://t.example/v1', model: 'tm' })
        expect(readTranslationProviderConfig({
            HAPI_TITLE_PROVIDER_BASE_URL: 'https://title.example/v1',
            HAPI_TITLE_PROVIDER_API_KEY: 'k',
            HAPI_TITLE_PROVIDER_MODEL: 'm'
        })).toMatchObject({ baseUrl: 'https://title.example/v1', model: 'm' })
        expect(readTranslationProviderConfig({})).toBeNull()
    })
})

describe('OpenAICompatibleTranslationProvider', () => {
    it('posts a chat completion and returns the message text', async () => {
        let body: Record<string, unknown> | null = null
        const provider = new OpenAICompatibleTranslationProvider(
            { baseUrl: 'https://p.example/v1/', apiKey: 'k', model: 'm' },
            async (url, init) => {
                expect(String(url)).toBe('https://p.example/v1/chat/completions')
                body = JSON.parse(String(init?.body))
                return Response.json({ choices: [{ message: { content: 'Fix the bug' } }] })
            }
        )
        expect(await provider.translate('修复 bug')).toBe('Fix the bug')
        expect(body!.model).toBe('m')
    })
})

describe('InputTranslationService', () => {
    it('falls back to the original text when the provider throws', async () => {
        const service = new InputTranslationService({ translate: async () => { throw new Error('boom') } })
        expect(await service.translate('你好')).toEqual({ translated: false, text: '你好', reason: 'boom' })
    })

    it('caches by key so a retried localId is translated once', async () => {
        let calls = 0
        const service = new InputTranslationService({ translate: async () => `Hello ${++calls}` })
        const first = await service.translate('你好', 's:l1')
        const second = await service.translate('你好', 's:l1')
        expect(first).toEqual(second)
        expect(calls).toBe(1)
    })
})

// ---------------------------------------------------------------------------
// MessageService integration
// ---------------------------------------------------------------------------

function makeIo(cliEmitted: unknown[]): Server {
    return {
        of: (ns: string) => ({
            to: (_room: string) => ({
                emit: (_event: string, data: unknown) => { if (ns === '/cli') cliEmitted.push(data) },
                timeout: (_ms: number) => ({ emit: () => {} })
            }),
            adapter: { rooms: { get: () => undefined } }
        })
    } as unknown as Server
}

function setup(
    provider: InputTranslationProvider | null,
    translateInput: boolean | 'unset' = true,
    readTranslateInputDefault?: () => Promise<boolean>
) {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(
        'translate',
        { path: '/tmp/translate', host: 'localhost', ...(translateInput !== 'unset' ? { translateInput } : {}) },
        null,
        'default'
    )
    const cliEmitted: unknown[] = []
    const publisher = { emit: () => {} }
    const service = new MessageService(
        store,
        makeIo(cliEmitted),
        publisher as never,
        undefined,
        new InputTranslationService(provider),
        readTranslateInputDefault
    )
    const sentContents = () => store.messages.getMessages(session.id, 50).map((m) => m.content as {
        content: { text: string }
        meta: Record<string, unknown>
    })
    return { service, session, sentContents, cliEmitted }
}

describe('MessageService input translation', () => {
    it('sends the English text to the agent and keeps the original in meta', async () => {
        const { service, session, sentContents, cliEmitted } = setup({ translate: async () => 'Fix the login bug' })
        await service.sendMessage(session.id, { text: '修复登录 bug', localId: 'l1' })
        const [content] = sentContents()
        expect(content.content.text).toBe('Fix the login bug')
        expect(content.meta.translatedFrom).toBe('修复登录 bug')
        expect(JSON.stringify(cliEmitted)).toContain('Fix the login bug')
    })

    it('sends the original text when translation fails', async () => {
        const { service, session, sentContents } = setup({ translate: async () => { throw new Error('down') } })
        await service.sendMessage(session.id, { text: '修复登录 bug', localId: 'l1' })
        const [content] = sentContents()
        expect(content.content.text).toBe('修复登录 bug')
        expect(content.meta.translatedFrom).toBeUndefined()
        expect(content.meta.translationFailed).toBe(true)
    })

    it('does not flag skipped inputs as failed translations', async () => {
        const { service, session, sentContents } = setup({ translate: async () => 'X' })
        await service.sendMessage(session.id, { text: '/compact', localId: 'l1' })
        expect(sentContents()[0].meta.translationFailed).toBeUndefined()
    })

    it('follows the hub default when the session has no explicit choice', async () => {
        const on = setup({ translate: async () => 'Hello' }, 'unset', async () => true)
        await on.service.sendMessage(on.session.id, { text: '你好', localId: 'l1' })
        expect(on.sentContents()[0].content.text).toBe('Hello')

        const off = setup({ translate: async () => 'Hello' }, 'unset', async () => false)
        await off.service.sendMessage(off.session.id, { text: '你好', localId: 'l1' })
        expect(off.sentContents()[0].content.text).toBe('你好')

        const unreadable = setup({ translate: async () => 'Hello' }, 'unset', async () => { throw new Error('bad settings') })
        await unreadable.service.sendMessage(unreadable.session.id, { text: '你好', localId: 'l1' })
        expect(unreadable.sentContents()[0].content.text).toBe('你好')
    })

    it('lets an explicit per-session choice override the hub default', async () => {
        let defaultReads = 0
        const readDefault = async () => { defaultReads += 1; return true }
        const off = setup({ translate: async () => 'Hello' }, false, readDefault)
        await off.service.sendMessage(off.session.id, { text: '你好', localId: 'l1' })
        expect(off.sentContents()[0].content.text).toBe('你好')
        expect(defaultReads).toBe(0)

        const on = setup({ translate: async () => 'Hello' }, true, async () => false)
        await on.service.sendMessage(on.session.id, { text: '你好', localId: 'l1' })
        expect(on.sentContents()[0].content.text).toBe('Hello')
    })

    it('does not translate when the session toggle is off, or for peer pings', async () => {
        const off = setup({ translate: async () => 'X' }, false)
        await off.service.sendMessage(off.session.id, { text: '你好', localId: 'l1' })
        expect(off.sentContents()[0].content.text).toBe('你好')

        const on = setup({ translate: async () => 'X' })
        await on.service.sendMessage(on.session.id, { text: '你好', localId: 'ping-peer-1' })
        expect(on.sentContents()[0].content.text).toBe('你好')
    })

    it('keeps send order when an earlier translation is slow', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const { service, session, sentContents } = setup({
            translate: async (text) => {
                if (text === '第一条') { await gate; return 'First' }
                return 'Second'
            }
        })
        const first = service.sendMessage(session.id, { text: '第一条', localId: 'l1' })
        const second = service.sendMessage(session.id, { text: '第二条', localId: 'l2' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(sentContents()).toHaveLength(0)
        release()
        await Promise.all([first, second])
        expect(sentContents().map((c) => c.content.text)).toEqual(['First', 'Second'])
    })
})
