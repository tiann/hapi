import type { CursorPermissionMode } from '@hapi/protocol/types';
import { cursorCliSkuBaseId, cursorModelBaseId, cursorModelBaseMatches, matchCliSkuToAcpWireId, parseCursorSkuParamHints, parseCursorWireParams, resolveCursorLegacyModelBase } from '@hapi/protocol';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { logger } from '@/ui/logger';

export type CursorAcpMode = 'agent' | 'plan' | 'ask' | 'debug';

function isDefaultCursorModelId(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

export function toCursorAcpMode(mode: CursorPermissionMode | undefined): CursorAcpMode {
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
    mode: CursorPermissionMode | undefined
): CursorPermissionMode {
    if (mode === 'plan' || mode === 'ask' || mode === undefined) {
        return 'default';
    }
    return mode;
}

/** True when HAPI permission mode should spawn/toggle Cursor Auto-review. */
export function isCursorAutoReviewMode(mode: CursorPermissionMode | undefined): boolean {
    return mode === 'autoReview';
}

function resolveAcpModeConfigValue(
    mode: CursorPermissionMode | undefined,
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
    mode: CursorPermissionMode | undefined
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
        return trimmedRequested;
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

function fastHintForCursorSkuOrWire(modelId: string): 'false' | 'true' {
    const lower = modelId.trim().toLowerCase();
    const fastMatch = lower.match(/[\[,](?:\s*)fast=(true|false)(?:\s*)[\],]/)
        ?? lower.match(/\[\s*fast=(true|false)\s*\]/);
    if (fastMatch?.[1] === 'true' || fastMatch?.[1] === 'false') {
        return fastMatch[1];
    }
    return lower.includes('-fast') ? 'true' : 'false';
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

function effortHintForCursorSkuOrWire(modelId: string): string | null {
    const params = modelId.includes('[')
        ? parseCursorWireParams(modelId)
        : parseCursorSkuParamHints(modelId);
    const hint = params.effort ?? params.reasoning ?? params.reasoning_effort;
    return hint?.trim() || null;
}

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
    const fast = fastHintForCursorSkuOrWire(requested);
    // Parameterized sessions advertise bare bases. A model option holding complete
    // wires belongs to the non-parameterized path, which applies the wire as-is.
    if (!optionHasValue(modelOption, baseModel)) {
        return 'unsupported';
    }

    try {
        await backend.setConfigOption(sessionId, modelOption.id, baseModel);

        // Selecting the base refreshes Cursor's per-model config options. Re-read them so
        // the parameters are applied against the model that is now active, and skipped
        // for models that do not expose that axis.
        const appliedParams: string[] = [];
        const activeFast = findConfigOption(backend, sessionId, 'fast');
        if (activeFast && optionHasValue(activeFast, fast)) {
            await backend.setConfigOption(sessionId, activeFast.id, fast);
            appliedParams.push(`fast=${fast}`);
        }

        const effortHint = effortHintForCursorSkuOrWire(requested);
        const effort = effortHint ? findEffortConfigOption(backend, sessionId, effortHint) : null;
        if (effort) {
            await backend.setConfigOption(sessionId, effort.option.id, effort.value);
            appliedParams.push(`${effort.option.id}=${effort.value}`);
        }

        // Only parameters that were actually applied belong in the pinned wire; a model
        // that exposes neither axis stays on its bare base.
        const resolved = appliedParams.length > 0
            ? `${baseModel}[${appliedParams.join(',')}]`
            : baseModel;
        backend.pinSessionModelWireId(sessionId, resolved);
        return { applied: true, resolvedWireId: resolved, requestedWireId: requested };
    } catch (error) {
        logger.debug('[cursor-acp] parameterized model config failed', error);
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
    if (!trimmed || isDefaultCursorModelId(trimmed)) {
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

    const trySetConfigOption = async (): Promise<boolean> => {
        if (!modelOption || !backend.setConfigOption) {
            return false;
        }
        try {
            await backend.setConfigOption(sessionId, modelOption.id, resolved);
            return true;
        } catch (error) {
            logger.debug('[cursor-acp] session/set_config_option failed, trying set_model', error);
            return false;
        }
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (await trySetConfigOption()) {
            backend.pinSessionModelWireId(sessionId, resolved);
            return { applied: true, resolvedWireId: resolved, requestedWireId: trimmed };
        }
        if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    return { applied: false };
}
