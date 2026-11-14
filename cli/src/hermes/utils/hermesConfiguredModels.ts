import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { HermesModelSummary } from '@hapi/protocol/apiTypes'

interface HermesYamlProviderConfig {
    models?: unknown
}

interface HermesYamlConfig {
    model?: {
        provider?: unknown
    }
    providers?: Record<string, HermesYamlProviderConfig | undefined>
}

export function resolveHermesConfigModels(
    configPath: string = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml'),
    currentModelId?: string | null
): HermesModelSummary[] | null {
    if (!existsSync(configPath)) return null

    let parsed: HermesYamlConfig | null = null
    try {
        parsed = parseYaml(readFileSync(configPath, 'utf8')) as HermesYamlConfig | null
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null

    const activeProvider = typeof parsed.model?.provider === 'string'
        ? parsed.model.provider.trim()
        : ''
    const providers = parsed.providers
    if (!activeProvider || !providers || typeof providers !== 'object') return null

    const activeConfig = providers[activeProvider]
    if (!activeConfig || !Array.isArray(activeConfig.models) || activeConfig.models.length === 0) {
        return null
    }

    const result: HermesModelSummary[] = []
    const seen = new Set<string>()

    const addProviderModels = (providerName: string, rawModels: unknown, isActive: boolean) => {
        if (!Array.isArray(rawModels)) return
        for (const entry of rawModels) {
            if (typeof entry !== 'string') continue
            const modelName = entry.trim()
            if (!modelName) continue
            const modelId = isActive ? `custom:${modelName}` : `custom:${providerName}:${modelName}`
            if (seen.has(modelId)) continue
            seen.add(modelId)
            result.push({
                modelId,
                name: modelName,
                description: `Provider: ${providerName}`
            })
        }
    }

    addProviderModels(activeProvider, activeConfig.models, true)
    for (const [providerName, providerConfig] of Object.entries(providers)) {
        if (providerName === activeProvider || !providerConfig) continue
        addProviderModels(providerName, providerConfig.models, false)
    }

    const current = typeof currentModelId === 'string' ? currentModelId.trim() : ''
    if (current && !seen.has(current)) {
        const displayName = current.includes(':') ? current.slice(current.indexOf(':') + 1) : current
        result.unshift({
            modelId: current,
            name: displayName,
            description: `Provider: ${activeProvider} • current`
        })
    }

    return result.length > 0 ? result : null
}
