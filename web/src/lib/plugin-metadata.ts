import {
    WebLocalizedTextSchema,
    localizeWebText,
    type WebLocalizedText
} from '@hapi/protocol/plugins'
import type { PluginCapabilityView, PluginDetail, PluginListItem } from '@hapi/protocol/plugins/admin'
import type { Locale } from '@/lib/i18n-context'

type PluginDisplaySource = Pick<PluginListItem, 'id' | 'name' | 'description' | 'display'>

export function localizedText(value: unknown, locale: Locale): string {
    const parsed = WebLocalizedTextSchema.safeParse(value)
    if (parsed.success) return localizeWebText(parsed.data, locale)
    return typeof value === 'string' ? value : ''
}

function firstText(values: unknown[], locale: Locale): string {
    for (const value of values) {
        const text = localizedText(value, locale).trim()
        if (text) return text
    }
    return ''
}

export function localizedPluginName(plugin: PluginDisplaySource, locale: Locale): string {
    return firstText([plugin.display?.name, plugin.name], locale) || plugin.id
}

export function localizedPluginDescription(plugin: PluginDisplaySource, locale: Locale): string | undefined {
    return firstText([plugin.display?.description, plugin.description], locale) || undefined
}

export function localizedCapabilityName(capability: PluginCapabilityView, locale: Locale): string {
    return firstText([capability.display?.name, capability.displayName], locale) || capability.capabilityId
}

export function localizedCapabilityDescription(capability: PluginCapabilityView, locale: Locale): string | undefined {
    return firstText([capability.display?.description, capability.description], locale) || undefined
}

export function localizedContributionName(options: {
    pluginId: string
    contributionId?: string
    display?: unknown
    fallback?: unknown
    locale: Locale
    unknownLabel: string
}): string {
    const display = options.display && typeof options.display === 'object'
        ? options.display as { name?: WebLocalizedText; description?: WebLocalizedText }
        : undefined
    return firstText([
        display?.name,
        options.fallback,
        options.contributionId
    ], options.locale) || options.unknownLabel
}

export function pluginFeatureIntroMarkdown(
    plugin: PluginDetail,
    locale: Locale
): string {
    const explicitIntro = localizedText(plugin.display?.featureIntro, locale).trim()
    if (explicitIntro) return explicitIntro

    return localizedPluginDescription(plugin, locale) ?? ''
}
