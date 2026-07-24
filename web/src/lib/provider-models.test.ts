import { describe, expect, it } from 'vitest'
import type { ProviderProfileView } from '@/types/api'
import { activeProviderProfile, mergeModelOptions, providerModelOptions } from './provider-models'

const profile: ProviderProfileView = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'GLM proxy',
    agent: 'codex',
    protocol: 'openai-chat-completions',
    credentialType: 'api-key',
    defaultModel: 'glm-5.2',
    models: [
        { id: 'glm-5.2', contextWindow: 1_000_000, source: 'custom' },
        { id: 'gpt-5', contextWindow: 200_000, source: 'provider', refreshedAt: 1 }
    ],
    health: { status: 'healthy', checkedAt: 1 },
    enabled: true,
    revision: 1,
    hasSecret: true,
    createdAt: 1,
    updatedAt: 1
}

describe('provider model options', () => {
    it('uses a profile default for machine-default selection', () => {
        expect(activeProviderProfile({
            agent: 'codex',
            profiles: [profile],
            defaults: { codex: profile.id },
            requestedId: undefined
        })?.id).toBe(profile.id)
    })

    it('shows a distinct 1M selection alongside the conservative base model', () => {
        expect(providerModelOptions(profile)).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: 'gpt-5', label: 'gpt-5 (200K)', group: 'GLM proxy · Provider' }),
            expect.objectContaining({ value: 'glm-5.2', label: 'glm-5.2 (200K)', group: 'GLM proxy · Custom' }),
            expect.objectContaining({ value: 'glm-5.2[1M]', label: 'glm-5.2[1M]', group: 'GLM proxy · Custom' })
        ]))
        expect(mergeModelOptions([{ value: 'auto', label: 'Default', group: 'Native' }], profile, 'glm-5.2[1M]'))
            .toEqual(expect.arrayContaining([expect.objectContaining({ value: 'glm-5.2[1M]' })]))
    })
})
