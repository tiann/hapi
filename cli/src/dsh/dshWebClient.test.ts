import { describe, expect, it } from 'vitest'
import { DshWebClient, DshWebRpcError, resolveDshWebUrl } from './dshWebClient'
import { listDshModels } from './dshModels'

function rpcFetch(values: Record<string, unknown>): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
        const value = values[request.method]
        return new Response(JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: value instanceof Error
                ? { ok: false, error: { code: 'failed', message: value.message } }
                : { ok: true, value }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
}

describe('DshWebClient', () => {
    it('normalizes the configured URL and rejects unsafe forms', () => {
        expect(resolveDshWebUrl('http://127.0.0.1:3080/path')).toBe('http://127.0.0.1:3080')
        expect(() => resolveDshWebUrl('ws://127.0.0.1:3080')).toThrow('http:// or https://')
        expect(() => resolveDshWebUrl('http://user:pass@127.0.0.1:3080')).toThrow('must not contain credentials')
    })

    it('parses provider-qualified models and reasoning efforts', async () => {
        const client = new DshWebClient('http://127.0.0.1:3080', rpcFetch({
            'session.models': {
                current: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
                groups: [{
                    id: 'deepseek-official',
                    name: 'DeepSeek',
                    models: [{
                        id: 'deepseek-v4-pro',
                        name: 'DeepSeek V4 Pro',
                        reasoning: {
                            defaultEffort: 'high',
                            efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }]
                        }
                    }]
                }]
            }
        }))

        await expect(client.getModels('session-1')).resolves.toEqual({
            current: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
            models: [{
                provider: 'deepseek-official',
                providerName: 'DeepSeek',
                model: 'deepseek-v4-pro',
                name: 'DeepSeek V4 Pro',
                reasoningEfforts: [
                    { id: 'high', name: 'High', isDefault: true },
                    { id: 'max', name: 'Max', isDefault: false }
                ]
            }]
        })
    })

    it('keeps DSH RPC errors structured', async () => {
        const client = new DshWebClient('http://127.0.0.1:3080', rpcFetch({
            'host.describe': new Error('not ready')
        }))
        const error = await client.describe().catch((value) => value)
        expect(error).toBeInstanceOf(DshWebRpcError)
        expect(error).toMatchObject({ method: 'host.describe', code: 'failed' })
    })

    it('discovers the model catalog from an existing native session', async () => {
        const client = new DshWebClient('http://127.0.0.1:3080', rpcFetch({
            'host.describe': {
                version: '0.0.1',
                cwd: '/tmp/project',
                provider: 'deepseek-official',
                model: 'deepseek-v4-pro',
                attachedSessions: 1
            },
            'session.list': {
                items: [{
                    sessionId: 'session-1',
                    updatedAt: 1,
                    running: true,
                    blank: false
                }]
            },
            'session.models': {
                current: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
                groups: [{
                    id: 'deepseek-official',
                    name: 'DeepSeek',
                    models: [{
                        id: 'deepseek-v4-pro',
                        name: 'DeepSeek V4 Pro',
                        reasoning: {
                            defaultEffort: 'max',
                            efforts: [{ id: 'max', name: 'Max' }]
                        }
                    }]
                }]
            }
        }))

        await expect(listDshModels(client)).resolves.toEqual({
            success: true,
            current: {
                provider: 'deepseek-official',
                modelId: 'deepseek-v4-pro',
                reasoningEffort: 'max'
            },
            availableModels: [{
                provider: 'deepseek-official',
                providerName: 'DeepSeek',
                modelId: 'deepseek-v4-pro',
                name: 'DeepSeek V4 Pro',
                reasoningEfforts: [{ id: 'max', name: 'Max', isDefault: true }]
            }]
        })
    })
})
