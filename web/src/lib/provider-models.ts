import type { AgentProvider, ProviderModel, ProviderProfileView } from '@/types/api'

export type GroupedModelOption = {
    value: string
    label: string
    group?: string
}

type ProviderDefaults = Partial<Record<AgentProvider, string | null>>

export function activeProviderProfile(args: {
    agent: AgentProvider | null
    profiles: ProviderProfileView[]
    defaults?: ProviderDefaults
    requestedId: string | null | undefined
}): ProviderProfileView | null {
    if (!args.agent || args.requestedId === null) return null
    const id = args.requestedId ?? args.defaults?.[args.agent] ?? null
    return args.profiles.find((profile) => profile.id === id && profile.enabled) ?? null
}

function contextLabel(model: Pick<ProviderModel, 'id' | 'contextWindow'>): string {
    return model.contextWindow === 1_000_000 ? `${model.id}[1M]` : `${model.id} (200K)`
}

/**
 * A 1M declaration provides an additional virtual model option. The plain
 * name remains the conservative 200K selection, while the `[1M]` selection
 * is converted back to the provider's raw model id by the CLI transport.
 */
export function providerModelOptions(profile: ProviderProfileView | null): GroupedModelOption[] {
    if (!profile) return []

    const options: GroupedModelOption[] = []
    const seen = new Set<string>()
    const add = (model: ProviderModel, group: string) => {
        if (!seen.has(model.id)) {
            seen.add(model.id)
            options.push({ value: model.id, label: `${model.id} (200K)`, group })
        }
        if (model.contextWindow === 1_000_000) {
            const reference = `${model.id}[1M]`
            if (!seen.has(reference)) {
                seen.add(reference)
                options.push({ value: reference, label: contextLabel(model), group })
            }
        }
    }

    for (const model of profile.models.filter((model) => model.source === 'provider')) {
        add(model, `${profile.name} · Provider`)
    }
    for (const model of profile.models.filter((model) => model.source === 'custom')) {
        add(model, `${profile.name} · Custom`)
    }
    if (profile.defaultModel && !seen.has(profile.defaultModel)) {
        options.unshift({ value: profile.defaultModel, label: profile.defaultModel, group: `${profile.name} · Default` })
    }
    return options
}

export function mergeModelOptions(
    native: GroupedModelOption[],
    profile: ProviderProfileView | null,
    currentModel?: string
): GroupedModelOption[] {
    const result = [...native]
    const seen = new Set(result.map((option) => option.value))
    for (const option of providerModelOptions(profile)) {
        if (seen.has(option.value)) continue
        seen.add(option.value)
        result.push(option)
    }
    if (currentModel && currentModel !== 'auto' && !seen.has(currentModel)) {
        result.splice(1, 0, { value: currentModel, label: currentModel, group: 'Current' })
    }
    return result
}
