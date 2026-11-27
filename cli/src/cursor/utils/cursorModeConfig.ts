import type { PermissionModeOf, Flavors } from '@hapi/protocol/types';
import { cursorCliSkuBaseId, cursorModelBaseId, cursorModelBaseMatches, isCursorAutoModelId, matchCliSkuToAcpWireId, parseCursorSkuParamHints, parseCursorWireParams, resolveCursorLegacyModelBase } from '@hapi/protocol';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { logger } from '@/ui/logger';

export type CursorAcpMode = 'agent' | 'plan' | 'ask' | 'debug';

export function toCursorAcpMode(mode: PermissionModeOf<typeof Flavors.cursor> | undefined): CursorAcpMode {
    if (mode === 'plan') return 'plan';
    if (mode === 'ask') return 'ask';
    if (mode === 'debug') return 'debug';
    // autoReview / yolo / default map to agent; auto-review is a spawn flag + slash, not ACP mode.
    return 'agent';
}

/**
 * Permission mode to use after the operator accepts a CreatePlan request.
 * Plan/ask are read-only planning modes — leave them for an executable mode so
 * "Yes" means continue the task, not "plan complete, stop".
 */
export function resolveCursorModeAfterPlanApproval(
    mode: PermissionModeOf<typeof Flavors.cursor> | undefined
): PermissionModeOf<typeof Flavors.cursor> {
    if (mode === 'plan' || mode === 'ask' || mode === undefined) {
        return 'default';
    }
    return mode;
}

/** True when HAPI permission mode should spawn/toggle Cursor Auto-review. */
export function isCursorAutoReviewMode(mode: PermissionModeOf<typeof Flavors.cursor> | undefined): boolean {
    return mode === 'autoReview';
}

function resolveAcpModeConfigValue(
    mode: PermissionModeOf<typeof Flavors.cursor> | undefined,
    backend: AcpSdkBackend,
    sessionId: string
): string {
    const acpMode = toCursorAcpMode(mode);
    const modeOption = backend.getConfigOptionByCategory?.(sessionId, 'mode');
    const optionValues = modeOption?.options.map((entry) => entry.value) ?? [];
    if (optionValues.includes(acpMode)) {
        return acpMode;
    }
    if (mode === 'yolo' || mode === 'default' || mode === 'autoReview') {
        if (optionValues.includes('agent')) {
            return 'agent';
        }
    }
    if (mode === 'debug' && optionValues.includes('debug')) {
        return 'debug';
    }
    return acpMode;
}

export async function applyCursorAcpMode(
    backend: AcpSdkBackend,
    sessionId: string,
    mode: PermissionModeOf<typeof Flavors.cursor> | undefined
): Promise<void> {
    const configValue = resolveAcpModeConfigValue(mode, backend, sessionId);

    const modeOption = backend.getConfigOptionByCategory?.(sessionId, 'mode');
    if (modeOption && backend.setConfigOption) {
        try {
            await backend.setConfigOption(sessionId, modeOption.id, configValue);
            return;
        } catch (error) {
            logger.debug('[cursor-acp] session/set_config_option for mode failed, trying set_mode', error);
        }
    }

    try {
        await backend.setMode(sessionId, configValue);
    } catch (error) {
        logger.warn(`[cursor-acp] Failed to set mode ${configValue}`, error);
    }
}

export type ApplyCursorAcpModelResult = {
    applied: boolean;
    partiallyAppliedWireId?: string;
    /** Wire id applied via ACP when switching succeeds */
    resolvedWireId?: string;
    /** Original hub/UI request before catalog resolution */
    requestedWireId?: string;
};

type ConfigOption = NonNullable<ReturnType<AcpSdkBackend['getConfigOptionByCategory']>>;
type ParameterizedCursorModelResult = ApplyCursorAcpModelResult | 'unsupported' | 'failed';

/**
 * Wire id stored on session + keepalive.
 * Spawn-safe requested ids (bare / CLI SKU) must stay spawn-safe — do not
 * re-persist ACP parameterized wires after apply (#1428 / #1430).
 */
export function wireIdForCursorSessionState(requested: string, resolved: string): string {
    const trimmedRequested = requested.trim();
    const trimmedResolved = resolved.trim();

    // Bare/SKU request: keep it even when ACP resolved a bracket wire.
    if (trimmedRequested && !trimmedRequested.includes('[')) {
        return trimmedRequested;
    }

    // Prefer a spawn-safe resolved id when the request was a wire.
    if (trimmedResolved && !trimmedResolved.includes('[')) {
        return trimmedResolved;
    }

    if (trimmedRequested.includes('[')) {
        const legacyBase = resolveCursorLegacyModelBase(cursorModelBaseId(trimmedRequested));
        if (legacyBase !== cursorModelBaseId(trimmedRequested)) {
            return trimmedResolved || trimmedRequested;
        }
        const actualParams = parseCursorWireParams(trimmedResolved);
        const requestedParams = Object.entries(parseCursorWireParams(trimmedRequested));
        return requestedParams.every(([key, value]) => actualParams[key] === value)
            ? trimmedRequested : trimmedResolved || trimmedRequested;
    }

    return trimmedResolved || trimmedRequested;
}

/**
 * Map a spawn / hub wire id onto a live ACP configOptions entry.
 * Uses exact match, then SKU/wire remap (including non-legacy bracket strip).
 */
export function resolveCursorAcpWireId(
    requested: string,
    available: readonly { modelId: string }[]
): string | null {
    const trimmed = requested.trim();
    if (!trimmed) {
        return null;
    }

    const exact = available.find((entry) => entry.modelId === trimmed);
    if (exact) {
        return exact.modelId;
    }

    return matchCliSkuToAcpWireId(trimmed, available);
}

function findConfigOption(backend: AcpSdkBackend, sessionId: string, key: string): ConfigOption | undefined {
    return backend.getConfigOptionByCategory?.(sessionId, key)
        ?? backend.getSessionConfigOptions?.(sessionId)?.find((option) => option.id === key || option.category === key);
}

function optionHasValue(option: ConfigOption | undefined, value: string): boolean {
    return Boolean(option?.options?.some((entry) => entry.value === value));
}

/** ACP acknowledgements may be empty. Only use values explicitly refreshed by this request. */
export async function setCursorModelOption(
    backend: AcpSdkBackend, sessionId: string, option: ConfigOption, value: string
): Promise<string> {
    const receipt = await backend.setConfigOption(sessionId, option.id, value);
    return receipt?.find((entry) => entry.id === option.id)?.currentValue ?? value;
}

function cursorRequestBaseId(modelId: string, modelOption?: ConfigOption): string {
    const raw = modelId.includes('[')
        ? cursorModelBaseId(modelId)
        : cursorCliSkuBaseId(modelId);
    // CLI skus may carry the legacy `cursor-` family prefix (cursor-grok-4.6-high).
    const advertised = modelOption?.options?.find((option) => cursorModelBaseMatches(option.value, raw));
    return advertised?.value ?? raw;
}

/** CLI sku / ACP wire effort values → Cursor config option values (aliases included). */
const EFFORT_OPTION_VALUES: Readonly<Record<string, readonly string[]>> = {
    none: ['none'],
    low: ['low'],
    medium: ['medium'],
    high: ['high'],
    xhigh: ['xhigh', 'extra-high'],
    'extra-high': ['extra-high', 'xhigh'],
    max: ['max']
};

/** Cursor exposes the effort axis under different ids per model family. */
const EFFORT_OPTION_IDS = ['effort', 'reasoning', 'reasoning_effort'] as const;

function resolveOptionValue(option: ConfigOption | undefined, candidates: readonly string[]): string | null {
    if (!option?.options?.length) {
        return null;
    }
    for (const candidate of candidates) {
        if (option.options.some((entry) => entry.value === candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Effort config option for the model that is currently selected. Ids are tried first
 * because `thought_level` also covers Claude's separate `thinking` toggle.
 */
function findEffortConfigOption(
    backend: AcpSdkBackend,
    sessionId: string,
    hint: string
): { option: ConfigOption; value: string } | null {
    const candidates = EFFORT_OPTION_VALUES[hint] ?? [hint];
    for (const id of EFFORT_OPTION_IDS) {
        const option = findConfigOption(backend, sessionId, id);
        const value = resolveOptionValue(option, candidates);
        if (option && value) {
            return { option, value };
        }
    }
    const thoughtLevel = backend.getConfigOptionByCategory?.(sessionId, 'thought_level');
    const value = resolveOptionValue(thoughtLevel, candidates);
    return thoughtLevel && value ? { option: thoughtLevel, value } : null;
}

async function applyParameterizedCursorModel(
    backend: AcpSdkBackend,
    sessionId: string,
    requested: string
): Promise<ParameterizedCursorModelResult> {
    const modelOption = findConfigOption(backend, sessionId, 'model');
    if (!modelOption || !backend.setConfigOption) {
        return 'unsupported';
    }

    const baseModel = cursorRequestBaseId(requested, modelOption);
    const explicitWire = requested.includes('[');
    const params = explicitWire ? parseCursorWireParams(requested) : parseCursorSkuParamHints(requested);
    // Parameterized sessions advertise bare bases. A model option holding complete
    // wires belongs to the non-parameterized path, which applies the wire as-is.
    if (!optionHasValue(modelOption, baseModel)) {
        return 'unsupported';
    }

    const knownKeys = ['thinking', 'context', 'fast', ...EFFORT_OPTION_IDS];
    if (Object.keys(params).some((key) => !knownKeys.includes(key))) return 'failed';

    let partiallyAppliedWireId: string | undefined;
    try {
        const activeBase = await setCursorModelOption(backend, sessionId, modelOption, baseModel);
        partiallyAppliedWireId = activeBase;
        if (activeBase !== baseModel) {
            throw new Error(`Cursor reported model ${activeBase} after requesting ${baseModel}`);
        }

        // Selecting a base can replace its option list. Resolve each dimension on the
        // active model, including changes caused by an earlier dimension in this request.
        const effort = params.effort ?? params.reasoning ?? params.reasoning_effort;
        const dimensions: Array<[string, string | undefined]> = [
            ['thinking', params.thinking], ['context', params.context], ['fast', params.fast], ['effort', effort]
        ];
        const appliedParams = new Map<string, string>();
        for (const [key, wanted] of dimensions) {
            if (wanted === undefined) continue;
            const choice = key === 'effort' ? findEffortConfigOption(backend, sessionId, wanted) : null;
            const option = key === 'effort' ? choice?.option : findConfigOption(backend, sessionId, key);
            const value = choice?.value ?? wanted;
            if (!optionHasValue(option, value) || !option) {
                // CLI SKUs assume normal speed, including on models without a speed switch.
                if (!explicitWire && key === 'fast' && wanted === 'false') continue;
                throw new Error(`Cursor model ${baseModel} does not offer ${key}=${wanted}`);
            }
            const receipt = await backend.setConfigOption(sessionId, option.id, value);
            appliedParams.set(option.id, value);
            // A later setting can reset an earlier one. Prefer fresh readback for every
            // dimension we set, while permitting older agents to acknowledge without it.
            const confirmedBase = receipt?.find((entry) => entry.id === modelOption.id)?.currentValue ?? baseModel;
            if (confirmedBase !== baseModel) {
                partiallyAppliedWireId = confirmedBase;
                throw new Error(`Cursor changed the active model to ${confirmedBase}`);
            }
            let matches = true;
            const confirmedParams: string[] = [];
            for (const [id, requestedValue] of appliedParams) {
                const actual = receipt?.find((entry) => entry.id === id)?.currentValue ?? requestedValue;
                confirmedParams.push(`${id}=${actual}`);
                if (actual !== requestedValue) matches = false;
            }
            partiallyAppliedWireId = `${baseModel}[${confirmedParams.join(',')}]`;
            if (!matches) throw new Error(`Cursor confirmed different parameters: ${partiallyAppliedWireId}`);
        }
        const resolved = partiallyAppliedWireId;
        backend.pinSessionModelWireId(sessionId, resolved);
        return { applied: true, resolvedWireId: resolved, requestedWireId: requested };
    } catch (error) {
        logger.debug('[cursor-acp] parameterized model config failed', error);
        if (partiallyAppliedWireId) {
            backend.pinSessionModelWireId(sessionId, partiallyAppliedWireId);
            return { applied: false, partiallyAppliedWireId };
        }
        return 'failed';
    }
}

/**
 * Apply a model from the live ACP configOptions list (Zed-style).
 * Only wire ids present in `availableModels` are accepted.
 */
export async function applyCursorAcpModel(
    backend: AcpSdkBackend,
    sessionId: string,
    modelId: string | null | undefined
): Promise<ApplyCursorAcpModelResult> {
    const trimmed = modelId?.trim();
    if (!trimmed || isCursorAutoModelId(trimmed)) {
        return { applied: false };
    }

    const metadata = backend.getSessionModelsMetadata(sessionId);
    const available = metadata?.availableModels ?? [];
    const modelOption = backend.getConfigOptionByCategory?.(sessionId, 'model');

    const parameterized = await applyParameterizedCursorModel(backend, sessionId, trimmed);
    if (parameterized === 'failed') {
        return { applied: false };
    }
    if (parameterized !== 'unsupported') {
        return parameterized;
    }

    // Prefer the live model-option value list for set_config_option. Merging in
    // metadata bare bases first lets spawn-safe remap return a bare id that the
    // option catalog rejects (wire-only options).
    const optionWireIds = modelOption?.options?.map((option) => ({ modelId: option.value })) ?? [];
    const resolved = (
        optionWireIds.length > 0
            ? resolveCursorAcpWireId(trimmed, optionWireIds)
            : null
    ) ?? resolveCursorAcpWireId(trimmed, [...available, ...optionWireIds]);
    if (!resolved) {
        logger.debug(`[cursor-acp] Model ${trimmed} is not in ACP configOptions; skipping`);
        return { applied: false };
    }
    if (
        modelOption?.options
        && modelOption.options.length > 0
        && !optionHasValue(modelOption, resolved)
    ) {
        logger.debug(`[cursor-acp] Model ${resolved} is not an ACP model option value; skipping`);
        return { applied: false };
    }

    if (!modelOption || !backend.setConfigOption) return { applied: false };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const actual = await setCursorModelOption(backend, sessionId, modelOption, resolved);
            backend.pinSessionModelWireId(sessionId, actual);
            if (actual !== resolved) return { applied: false, partiallyAppliedWireId: actual };
            return { applied: true, resolvedWireId: resolved, requestedWireId: trimmed };
        } catch (error) {
            logger.debug('[cursor-acp] session/set_config_option failed for model', error);
        }
        if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    return { applied: false };
}
