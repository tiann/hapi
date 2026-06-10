import type { CursorPermissionMode } from '@hapi/protocol/types';
import { matchCliSkuToAcpWireId } from '@hapi/protocol';
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
    return 'agent';
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
    if (mode === 'yolo' || mode === 'default') {
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

/** Wire id stored on session + keepalive (preserve explicit variant picks). */
export function wireIdForCursorSessionState(requested: string, resolved: string): string {
    const trimmed = requested.trim();
    if (trimmed.includes('[')) {
        return trimmed;
    }
    return resolved;
}

/**
 * Map a spawn / hub wire id onto a live ACP configOptions entry.
 * Exact wire ids only — no legacy alias, base-only, or nearest-variant fallback.
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
    const optionWireIds = modelOption?.options?.map((option) => ({ modelId: option.value })) ?? [];
    const catalog = [...available, ...optionWireIds];
    const resolved = resolveCursorAcpWireId(trimmed, catalog);
    if (!resolved) {
        logger.debug(`[cursor-acp] Model ${trimmed} is not in ACP configOptions; skipping`);
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
