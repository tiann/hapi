import { describe, expect, it } from 'vitest'
import {
    ProviderProfileInputSchema,
    ProviderProfileUpdateSchema,
    parseProviderModelReference
} from './providerManagement'

describe('provider profile schemas', () => {
    it('allows Claude auth tokens but requires API keys for Codex', () => {
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Claude token',
            agent: 'claude',
            protocol: 'anthropic-messages',
            credentialType: 'auth-token',
            apiKey: 'secret'
        }).success).toBe(true)
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Codex token',
            agent: 'codex',
            protocol: 'openai-responses',
            credentialType: 'auth-token',
            apiKey: 'secret'
        }).success).toBe(false)
    })

    it('rejects Codex-only fields on explicit Claude updates', () => {
        expect(ProviderProfileUpdateSchema.safeParse({}).success).toBe(false)
        expect(ProviderProfileUpdateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' })
        expect(ProviderProfileUpdateSchema.safeParse({
            agent: 'claude',
            codexWireApi: 'responses'
        }).success).toBe(false)
        expect(ProviderProfileUpdateSchema.safeParse({
            agent: 'claude',
            codexWireApi: null
        }).success).toBe(true)
    })

    it('limits provider base URLs to HTTP endpoints', () => {
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Local proxy',
            agent: 'codex',
            protocol: 'openai-responses',
            baseUrl: 'http://127.0.0.1:8080/v1',
            credentialType: 'api-key',
            apiKey: 'secret'
        }).success).toBe(true)
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Invalid proxy',
            agent: 'codex',
            protocol: 'openai-responses',
            baseUrl: 'file:///tmp/provider',
            credentialType: 'api-key',
            apiKey: 'secret'
        }).success).toBe(false)
    })

    it('requires an Agent-compatible protocol and allows Grok provider profiles', () => {
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Grok compatible',
            agent: 'grok',
            protocol: 'openai-chat-completions',
            apiKey: 'secret'
        }).success).toBe(true)
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Wrong Claude protocol',
            agent: 'claude',
            protocol: 'openai-chat-completions',
            apiKey: 'secret'
        }).success).toBe(false)
        expect(ProviderProfileInputSchema.safeParse({
            name: 'Cursor cannot use arbitrary endpoints',
            agent: 'cursor',
            protocol: 'openai-chat-completions',
            apiKey: 'secret'
        }).success).toBe(false)
    })

    it('normalizes 1M model declarations without leaking the display suffix into the API model id', () => {
        expect(parseProviderModelReference('glm-5.2[1M]')).toEqual({
            id: 'glm-5.2',
            contextWindow: 1_000_000
        })
        expect(parseProviderModelReference('glm-5.2')).toEqual({
            id: 'glm-5.2',
            contextWindow: 200_000
        })
    })

})
