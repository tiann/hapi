import { asString, isObject } from '@hapi/protocol';

export type GrokEffortOption = { id: string; label: string; description?: string; isDefault: boolean };
export type GrokModelOption = { id: string; name: string; description?: string; efforts: GrokEffortOption[] };
export type GrokCommand = { name: string; description?: string };
export type GrokCapabilities = {
    version: string | null;
    loadSession: boolean;
    image: boolean;
    currentModelId: string | null;
    currentEffort: string | null;
    models: GrokModelOption[];
    commands: GrokCommand[];
};

function parseEfforts(value: unknown): GrokEffortOption[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (!isObject(entry)) return [];
        const id = asString(entry.id ?? entry.value);
        if (!id) return [];
        return [{
            id,
            label: asString(entry.label) ?? id,
            ...(asString(entry.description) ? { description: asString(entry.description)! } : {}),
            isDefault: entry.default === true
        }];
    });
}

export function parseGrokCapabilities(response: unknown): GrokCapabilities {
    const root = isObject(response) ? response : {};
    const meta = isObject(root._meta) ? root._meta : {};
    const agentCapabilities = isObject(root.agentCapabilities) ? root.agentCapabilities : {};
    const promptCapabilities = isObject(agentCapabilities.promptCapabilities) ? agentCapabilities.promptCapabilities : {};
    const modelState = isObject(meta.modelState) ? meta.modelState : {};
    const models = Array.isArray(modelState.availableModels)
        ? modelState.availableModels.flatMap((entry) => {
            if (!isObject(entry)) return [];
            const id = asString(entry.modelId ?? entry.id);
            if (!id) return [];
            const modelMeta = isObject(entry._meta) ? entry._meta : {};
            return [{
                id,
                name: asString(entry.name) ?? id,
                ...(asString(entry.description) ? { description: asString(entry.description)! } : {}),
                efforts: parseEfforts(modelMeta.reasoningEfforts)
            }];
        })
        : [];
    const currentModelId = asString(modelState.currentModelId);
    const currentModel = models.find((model) => model.id === currentModelId);
    const currentEffort = currentModel?.efforts.find((effort) => effort.isDefault)?.id ?? null;
    const commands = Array.isArray(meta.availableCommands)
        ? meta.availableCommands.flatMap((entry) => {
            if (!isObject(entry)) return [];
            const name = asString(entry.name);
            if (!name) return [];
            return [{ name, ...(asString(entry.description) ? { description: asString(entry.description)! } : {}) }];
        })
        : [];
    return {
        version: asString(meta.agentVersion),
        loadSession: agentCapabilities.loadSession === true,
        image: promptCapabilities.image === true,
        currentModelId,
        currentEffort,
        models,
        commands
    };
}
