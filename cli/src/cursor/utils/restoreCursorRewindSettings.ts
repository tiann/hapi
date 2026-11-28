import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { PermissionMode } from '../loop';
import { toCursorAcpMode } from './cursorModeConfig';

const modelParameters = new Set(['thinking', 'context', 'fast', 'effort', 'reasoning', 'reasoning_effort', 'thought_level']);

function selectedModel(backend: AcpSdkBackend, id: string): string | undefined {
    return backend.getConfigOptionByCategory(id, 'model')?.currentValue ?? backend.getSessionModelsMetadata(id)?.currentModelId ?? undefined;
}

/** Confirm the replacement's native settings before the Hub truncates the source transcript. */
export async function restoreCursorRewindSettings(
    source: AcpSdkBackend, sourceId: string, candidate: AcpSdkBackend, id: string, mode: PermissionMode
): Promise<void> {
    const policy = candidate.getConfigOptionByCategory(id, 'mode');
    const smart = policy?.options.find(({ value }) => value === 'auto-review' || value === 'autoReview');
    if (mode === 'autoReview' && !smart) throw new Error('Cursor cannot verify Smart Auto at the rewind point');
    const target = mode === 'autoReview' && smart ? smart.value : toCursorAcpMode(mode);
    if (policy) {
        try {
            await candidate.setConfigOption(id, policy.id, target);
        } catch (error) {
            if (smart) throw error;
            await candidate.setMode(id, target);
        }
    } else {
        await candidate.setMode(id, target);
    }

    // Copy the native model and each advertised parameter, even when HAPI stores
    // a shorter spawn-safe model name. Read from the source before changing the candidate.
    const model = selectedModel(source, sourceId);
    if (!model) throw new Error('Cursor did not report the source model for rewind');
    const parameters = (source.getSessionConfigOptions?.(sourceId) ?? [])
        .filter(option => modelParameters.has(option.id) || modelParameters.has(option.category ?? ''));
    if (selectedModel(candidate, id) !== model) {
        const picker = candidate.getConfigOptionByCategory(id, 'model');
        if (picker) await candidate.setConfigOption(id, picker.id, model);
        else await candidate.setModel(id, model);
    }
    const readParameter = (key: string) => candidate.getSessionConfigOptions?.(id)?.find(option => option.id === key)?.currentValue;
    for (const { id: key, currentValue } of parameters) {
        if (currentValue === undefined) throw new Error(`Cursor did not report the source model parameter ${key}`);
        if (readParameter(key) !== currentValue) await candidate.setConfigOption(id, key, currentValue);
    }
    if (selectedModel(candidate, id) !== model || parameters.some(option => readParameter(option.id) !== option.currentValue)) {
        throw new Error('Cursor could not restore the exact model settings at the rewind point');
    }
    const reported = candidate.getConfigOptionByCategory(id, 'mode')?.currentValue;
    if ((smart || reported !== undefined) && reported !== target) {
        throw new Error('Cursor could not restore the permission mode at the rewind point');
    }
}
