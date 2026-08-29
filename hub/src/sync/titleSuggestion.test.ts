import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '../store'
import { Store } from '../store'
import {
    buildTitleConversation,
    createTitleSuggestionService,
    normalizeTitleSuggestion,
    OpenAICompatibleTitleProvider,
    readTitleProviderConfig,
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
            HAPI_TITLE_PROVIDER_MODEL: 'small-model',
            HAPI_TITLE_PROVIDER_TIMEOUT_MS: '20000'
        })).toEqual({
            baseUrl: 'https://example.test/v1',
            apiKey: 'secret',
            model: 'small-model',
            timeoutMs: 20_000
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

    it('surfaces a safe provider HTTP reason without exposing credentials', async () => {
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1',
            apiKey: 'secret',
            model: 'small-model'
        },
            async () => new Response(JSON.stringify({
                error: 'sk-live-secret'
            }), { status: 401, statusText: 'Unauthorized' })
        )

        await expect(provider.suggest('Recent conversation')).rejects.toThrow(
            'Title provider request failed (HTTP 401): authentication failed'
        )
    })

    it('reports a timeout when the response body aborts after headers arrive', async () => {
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1',
                apiKey: 'secret',
                model: 'small-model',
                timeoutMs: 50
            },
            async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => {
                    const error = new Error('aborted while reading body')
                    error.name = 'AbortError'
                    throw error
                }
            } as unknown as Response)
        )

        await expect(provider.suggest('Recent conversation')).rejects.toThrow(
            'Title provider request timed out after 50 ms'
        )
    })

    it('falls back to settings.json values and lets environment values override them per field', () => {
        const settings = {
            baseUrl: 'https://settings.example/v1',
            apiKey: 'settings-secret',
            model: 'settings-model'
        }

        expect(readTitleProviderConfig({}, settings)).toEqual({
            baseUrl: 'https://settings.example/v1',
            apiKey: 'settings-secret',
            model: 'settings-model',
            timeoutMs: 10_000
        })
        expect(readTitleProviderConfig({
            HAPI_TITLE_PROVIDER_BASE_URL: 'https://env.example/v1',
            HAPI_TITLE_PROVIDER_MODEL: 'env-model',
            HAPI_TITLE_PROVIDER_TIMEOUT_MS: '25000'
        }, settings)).toEqual({
            baseUrl: 'https://env.example/v1',
            apiKey: 'settings-secret',
            model: 'env-model',
            timeoutMs: 25_000
        })
        expect(readTitleProviderConfig({
            HAPI_TITLE_PROVIDER_TIMEOUT_MS: 'not-a-number'
        }, { ...settings, timeoutMs: 15_000 })).toMatchObject({ timeoutMs: 15_000 })
        expect(readTitleProviderConfig({}, { ...settings, apiKey: '   ' })).toBeNull()
    })

    it('uses the configured timeout when the provider request does not complete', async () => {
        const provider = new OpenAICompatibleTitleProvider(
            {
                baseUrl: 'https://example.test/v1',
                apiKey: 'secret',
                model: 'small-model',
                timeoutMs: 5
            },
            async (_input, init) => await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const error = new Error('aborted')
                    error.name = 'AbortError'
                    reject(error)
                })
            })
        )

        await expect(provider.suggest('Recent conversation')).rejects.toThrow(
            'Title provider request timed out after 5 ms'
        )
    })

    it('normalizes a one-line title and caps it for the metadata field', () => {
        expect(normalizeTitleSuggestion('Title: "A useful title"\nExtra text')).toBe('A useful title')
        expect(normalizeTitleSuggestion('  Generated title with trailing spaces   ')).toBe('Generated title with trailing spaces')
        expect(normalizeTitleSuggestion('   ')).toBeNull()
        expect(normalizeTitleSuggestion('x'.repeat(100))).toHaveLength(80)
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
        const unavailable = createTitleSuggestionService(store, null)
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

    it('does not forward arbitrary provider errors from injected providers', async () => {
        const { store, sessionId } = makeStore()
        store.messages.addMessage(sessionId, {
            role: 'user',
            content: { type: 'text', text: 'Title this conversation' }
        })

        const service = new TitleSuggestionService(store, {
            provider: {
                suggest: async () => {
                    throw new Error('Title provider returned HTTP 404 Not Found: model not found')
                }
            }
        })

        await expect(service.suggestTitle(sessionId)).rejects.toMatchObject({
            code: 'provider',
            status: 502,
            message: 'The title suggestion provider failed'
        })
    })
})
