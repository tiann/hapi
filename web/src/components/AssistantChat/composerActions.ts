import {
    WebComposerActionDescriptorSchema,
    localizeWebText,
    type PluginCapabilityView,
    type WebComposerActionDescriptor,
    type WebComposerActionUi,
} from '@hapi/protocol/plugins'

export type PluginMessageComposerAction = WebComposerActionDescriptor & {
    pluginId: string
    pluginName?: string
    capabilityId?: string
}

function localizeComposerActionUi(ui: WebComposerActionUi, locale?: string): WebComposerActionUi {
    if (ui.kind === 'delayPicker') {
        return {
            ...ui,
            presets: ui.presets.map((preset) => ({
                ...preset,
                label: localizeWebText(preset.label, locale),
            })),
        }
    }
    if (ui.kind === 'confirm') {
        return {
            ...ui,
            title: localizeWebText(ui.title, locale),
            ...(ui.body ? { body: localizeWebText(ui.body, locale) } : {}),
        }
    }
    if (ui.kind === 'schemaForm') {
        return {
            ...ui,
            fields: ui.fields.map((field) => ({
                ...field,
                label: localizeWebText(field.label, locale),
                ...(field.description ? { description: localizeWebText(field.description, locale) } : {}),
                ...(field.options ? {
                    options: field.options.map((option) => ({
                        ...option,
                        ...(option.label ? { label: localizeWebText(option.label, locale) } : {}),
                    })),
                } : {}),
            })),
        }
    }
    return ui
}

export function collectPluginMessageComposerActions(
    capabilities: PluginCapabilityView[] | undefined,
    options: { locale?: string } = {}
): PluginMessageComposerAction[] {
    const actions: PluginMessageComposerAction[] = []

    for (const capability of capabilities ?? []) {
        if (capability.kind !== 'chat.composer.messageAction' || capability.status !== 'ready') {
            continue
        }
        for (const rawAction of capability.web?.composerActions ?? []) {
            const parsed = WebComposerActionDescriptorSchema.safeParse(rawAction)
            if (!parsed.success) continue
            actions.push({
                ...parsed.data,
                // Normalize labels early so descriptors with locale maps remain
                // renderable even when a plugin omitted the current locale.
                label: localizeWebText(parsed.data.label, options.locale),
                ...(parsed.data.description ? { description: localizeWebText(parsed.data.description, options.locale) } : {}),
                ui: localizeComposerActionUi(parsed.data.ui, options.locale),
                capabilityId: parsed.data.capabilityId ?? capability.capabilityId,
                pluginId: capability.pluginId,
                pluginName: capability.pluginName,
            })
        }
    }

    return actions
}
