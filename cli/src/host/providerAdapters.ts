import type { AgentProvider, ProviderProfileView } from '@hapi/protocol'
import type { ResolvedProviderProfile } from './providerRegistry'

export type AgentLaunchConfiguration = {
    env: Record<string, string>
    args: string[]
    defaultModel?: string
    profile: Pick<ProviderProfileView, 'id' | 'name' | 'revision'>
}

function tomlString(value: string): string {
    return JSON.stringify(value)
}

function profileReference(profile: ResolvedProviderProfile): AgentLaunchConfiguration['profile'] {
    return { id: profile.id, name: profile.name, revision: profile.revision }
}

export function resolveProviderLaunch(
    agent: AgentProvider,
    profile: ResolvedProviderProfile
): AgentLaunchConfiguration {
    if (profile.agent !== agent) throw new Error('Provider profile does not support this agent')

    if (agent === 'claude') {
        const credentialName = profile.credentialType === 'auth-token'
            ? 'ANTHROPIC_AUTH_TOKEN'
            : 'ANTHROPIC_API_KEY'
        return {
            env: {
                [credentialName]: profile.apiKey,
                ...(profile.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl } : {})
            },
            args: [],
            ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
            profile: profileReference(profile)
        }
    }

    if (agent === 'grok') {
        return {
            env: {
                XAI_API_KEY: profile.apiKey,
                ...(profile.baseUrl ? { XAI_BASE_URL: profile.baseUrl } : {})
            },
            args: [],
            ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
            profile: profileReference(profile)
        }
    }

    if (!profile.baseUrl) {
        return {
            env: { OPENAI_API_KEY: profile.apiKey },
            args: [],
            ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
            profile: profileReference(profile)
        }
    }

    const providerId = `hapi_${profile.id.replace(/-/g, '')}`
    const secretEnvName = 'HAPI_CODEX_PROVIDER_API_KEY'
    return {
        env: { [secretEnvName]: profile.apiKey },
        args: [
            '-c', `model_provider=${tomlString(providerId)}`,
            '-c', `model_providers.${providerId}.name=${tomlString(profile.name)}`,
            '-c', `model_providers.${providerId}.base_url=${tomlString(profile.baseUrl)}`,
            '-c', `model_providers.${providerId}.env_key=${tomlString(secretEnvName)}`,
            '-c', `model_providers.${providerId}.wire_api=${tomlString(
                profile.protocol === 'openai-chat-completions' ? 'chat' : 'responses'
            )}`
        ],
        ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
        profile: profileReference(profile)
    }
}
