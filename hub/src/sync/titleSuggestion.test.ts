import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '../store'
import { Store } from '../store'
import {
    buildTitleConversation,
    createTitleSuggestionService,
    normalizeTitleSuggestion,
    OpenAICompatibleTitleProvider,
    readTitleProviderConfig,
    readTitleProviderRequestLimits,
    readTitleSuggestionLimits,
    TitleSuggestionError,
    TitleSuggestionService
} from './titleSuggestion'

function message(seq: number, content: unknown, invokedAt: number | null = 1): StoredMessage {
    return {
        id: `message-${seq}`,
        sessionId: 'session-1',
        content,
        createdAt: seq,
        seq,
        localId: null,
        invokedAt,
        scheduledAt: null
    }
}

function makeStore(): { store: Store; sessionId: string } {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(
        'title-test',
        { path: '/tmp/title-test', host: 'localhost' },
        null,
        'default'
    )
    return { store, sessionId: session.id }
}

describe('title suggestion input preparation', () => {
    it('keeps recent user and assistant text while excluding queued, tool, and metadata output', () => {
        const conversation = buildTitleConversation([
            message(1, { role: 'user', content: { type: 'text', text: 'How do I deploy this app?' } }),
            message(2, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Use the deployment guide.\nAGENT_NOTIFY_SUMMARY {"summary":"done"}' } } }),
            message(3, { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } }),
            message(4, { role: 'user', content: { type: 'text', text: 'This queued prompt should not be used.' } }, null)
        ])

        expect(conversation).toContain('User: How do I deploy this app?')
        expect(conversation).toContain('Assistant: Use the deployment guide.')
        expect(conversation).not.toContain('AGENT_NOTIFY_SUMMARY')
        expect(conversation).not.toContain('queued prompt')
        expect(conversation).not.toContain('shell')
    })
})

describe('OpenAI-compatible title provider', () => {
    it('reads server-only provider settings and posts a chat completion request', async () => {
        expect(readTitleProviderConfig({
            HAPI_TITLE_PROVIDER_BASE_URL: 'https://example.test/v1',
            HAPI_TITLE_PROVIDER_API_KEY: 'secret',
            HAPI_TITLE_PROVIDER_MODEL: 'small-model'
        })).toEqual({
            baseUrl: 'https://example.test/v1',
            apiKey: 'secret',
            model: 'small-model'
        })
        expect(readTitleProviderConfig({ HAPI_TITLE_PROVIDER_API_KEY: 'secret' })).toBeNull()
        expect(readTitleSuggestionLimits({
            HAPI_TITLE_SUGGESTION_RATE_LIMIT: '2',
            HAPI_TITLE_SUGGESTION_RATE_WINDOW_MS: '60000'
        })).toEqual({ rateLimit: 2, rateWindowMs: 60_000 })

        let request: Request | undefined
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1/',
                apiKey: 'secret',
                model: 'small-model'
            },
            async (input, init) => {
                request = new Request(String(input), init)
                return new Response(JSON.stringify({
                    choices: [{ message: { content: '  Deployment guide  ' } }]
                }), { status: 200 })
            }
        )

        await expect(provider.suggest('Recent conversation')).resolves.toBe('Deployment guide')
        expect(request).toBeDefined()
        if (!request) throw new Error('request was not captured')
        expect(request.url).toBe('https://example.test/v1/chat/completions')
        expect(request.headers.get('authorization')).toBe('Bearer secret')
        expect(await request.json()).toMatchObject({ model: 'small-model' })
    })

    it('normalizes a one-line title and caps it for the metadata field', () => {
        expect(normalizeTitleSuggestion('Title: "A useful title"\nExtra text')).toBe('A useful title')
        expect(normalizeTitleSuggestion('   ')).toBeNull()
        expect(normalizeTitleSuggestion('x'.repeat(100))).toHaveLength(80)
    })

    it('honors env-tunable max_tokens and timeout', async () => {
        expect(readTitleProviderRequestLimits({})).toEqual({ maxTokens: 64, timeoutMs: 10_000 })
        expect(readTitleProviderRequestLimits({
            HAPI_TITLE_PROVIDER_MAX_TOKENS: '4096',
            HAPI_TITLE_PROVIDER_TIMEOUT_MS: '90000'
        })).toEqual({ maxTokens: 4096, timeoutMs: 90_000 })
        // Invalid values fall back to the defaults instead of breaking startup.
        expect(readTitleProviderRequestLimits({ HAPI_TITLE_PROVIDER_MAX_TOKENS: '-5' })).toEqual({ maxTokens: 64, timeoutMs: 10_000 })

        let request: Request | undefined
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1',
                apiKey: 'secret',
                model: 'small-model',
                maxTokens: 4096
            },
            async (input, init) => {
                request = new Request(String(input), init)
                return new Response(JSON.stringify({
                    choices: [{ message: { content: 'Title' } }]
                }), { status: 200 })
            }
        )

        await provider.suggest('Recent conversation')
        expect(await request?.json()).toMatchObject({ max_tokens: 4096 })
    })

    it('aborts the request when the configured timeout elapses', async () => {
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1',
                apiKey: 'secret',
                model: 'small-model',
                timeoutMs: 20
            },
            async (input, init) => {
                return new Promise((resolve, reject) => {
                    const signal = init?.signal
                    if (!signal) throw new Error('expected an AbortSignal')
                    signal.addEventListener('abort', () => reject(signal.reason))
                })
            }
        )

        await expect(provider.suggest('Recent conversation')).rejects.toMatchObject({ name: 'AbortError' })
    })
})

describe('TitleSuggestionService', () => {
    it('uses the recent store messages and returns a normalized title', async () => {
        const { store, sessionId } = makeStore()
        store.messages.addMessage(sessionId, {
            role: 'user',
            content: { type: 'text', text: 'Explain the release process' }
        })
        store.messages.addMessage(sessionId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'Here is the release process.' } }
        })

        const prompts: string[] = []
        const service = new TitleSuggestionService(store, {
            provider: {
                suggest: async (prompt) => {
                    prompts.push(prompt)
                    return 'Release process overview'
                }
            }
        })

        await expect(service.suggestTitle(sessionId)).resolves.toBe('Release process overview')
        expect(prompts[0]).toContain('Explain the release process')
    })

    it('uses display-position order when a queued prompt is invoked late', async () => {
        const { store, sessionId } = makeStore()
        store.messages.addMessage(
            sessionId,
            { role: 'user', content: { type: 'text', text: 'The late queued prompt is the current topic' } },
            'queued-local-id'
        )
        for (let index = 0; index < 201; index += 1) {
            store.messages.addMessage(
                sessionId,
                { role: 'user', content: { type: 'text', text: `Older stored message ${index}` } }
            )
        }

        const latestStoredMessage = store.messages.getMessages(sessionId).at(-1)
        if (!latestStoredMessage) throw new Error('Expected test messages')
        store.messages.markMessagesInvoked(
            sessionId,
            ['queued-local-id'],
            latestStoredMessage.createdAt + 1
        )

        let prompt = ''
        const service = new TitleSuggestionService(store, {
            provider: {
                suggest: async (value) => {
                    prompt = value
                    return 'Current topic'
                }
            }
        })

        await expect(service.suggestTitle(sessionId)).resolves.toBe('Current topic')
        expect(prompt).toContain('The late queued prompt is the current topic')
    })

    it('reports unavailable configuration and enforces the per-session request limit', async () => {
        const { store, sessionId } = makeStore()
        const unavailable = createTitleSuggestionService(store)
        await expect(unavailable.suggestTitle(sessionId)).rejects.toMatchObject({
            code: 'unavailable',
            status: 503
        })

        store.messages.addMessage(sessionId, {
            role: 'user',
            content: { type: 'text', text: 'Title this' }
        })
        const service = new TitleSuggestionService(store, {
            provider: { suggest: async () => 'Title' },
            now: () => 100,
            rateLimit: 1,
            rateWindowMs: 1_000
        })
        await expect(service.suggestTitle(sessionId)).resolves.toBe('Title')
        await expect(service.suggestTitle(sessionId)).rejects.toMatchObject({
            code: 'rate-limited',
            status: 429
        })
    })
})
