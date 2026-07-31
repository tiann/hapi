/** Renamed ACP wire bases → live Cursor CLI sku family (e.g. grok-4.5 → cursor-grok-4.5). */
const CURSOR_LEGACY_MODEL_BASE_ALIASES: Readonly<Record<string, string>> = {
    'grok-4.5': 'cursor-grok-4.5',
};

export function resolveCursorLegacyModelBase(baseId: string): string {
    const trimmed = baseId.trim();
    return CURSOR_LEGACY_MODEL_BASE_ALIASES[trimmed] ?? trimmed;
}

/** ACP wire ids use bracket params; CLI `agent --list-models` slugs do not. */
export function isCursorAcpWireModelId(modelId: string): boolean {
    const trimmed = modelId.trim();
    return trimmed === 'default[]' || trimmed.includes('[');
}

export function cursorModelBaseId(modelId: string): string {
    const trimmed = modelId.trim();
    const bracket = trimmed.indexOf('[');
    return bracket === -1 ? trimmed : trimmed.slice(0, bracket);
}

/** Longest-first suffixes from Cursor CLI sku ids (e.g. `gpt-5.5-high-fast` → `gpt-5.5`). */
const CLI_SKU_SUFFIXES = [
    '-extra-high-fast',
    '-extra-high',
    '-xhigh-fast',
    '-xhigh',
    '-high-fast',
    '-high',
    '-medium-fast',
    '-medium',
    '-low-fast',
    '-low',
    '-none-fast',
    '-none',
    '-thinking-high-fast',
    '-thinking-high',
    '-thinking',
    '-fast',
] as const;

export function cursorCliSkuBaseId(slug: string): string {
    const trimmed = slug.trim();
    if (!trimmed || isCursorAcpWireModelId(trimmed)) {
        return cursorModelBaseId(trimmed);
    }

    let base = trimmed;
    let changed = true;
    while (changed) {
        changed = false;
        for (const suffix of CLI_SKU_SUFFIXES) {
            if (base.endsWith(suffix)) {
                base = base.slice(0, -suffix.length);
                changed = true;
                break;
            }
        }
    }
    return base;
}

export function parseCursorWireParams(modelId: string): Record<string, string> {
    const variant = modelId.includes('[') ? modelId.slice(modelId.indexOf('[') + 1).replace(/\]$/, '') : '';
    if (!variant) {
        return {};
    }

    const params: Record<string, string> = {};
    for (const part of variant.split(',')) {
        const segment = part.trim();
        if (!segment) continue;
        const eq = segment.indexOf('=');
        if (eq === -1) {
            params[segment] = 'true';
            continue;
        }
        params[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
    }
    return params;
}

function inferSkuParamHints(slug: string): Record<string, string> {
    const lower = slug.toLowerCase();
    const hints: Record<string, string> = {};

    if (lower.includes('extra-high') || lower.includes('xhigh')) {
        hints.reasoning = 'extra-high';
        hints.effort = 'xhigh';
    } else if (lower.includes('-high')) {
        hints.reasoning = 'high';
        hints.effort = 'high';
    } else if (lower.includes('-low')) {
        hints.reasoning = 'low';
        hints.effort = 'low';
    } else if (lower.includes('-medium')) {
        hints.reasoning = 'medium';
        hints.effort = 'medium';
    } else if (lower.includes('-none')) {
        hints.reasoning = 'none';
    }

    // Cursor CLI convention: `-fast` suffix means fast=true; absence means fast=false.
    // Without an explicit hint, base-only SKUs (e.g. `composer-2.5`) would tie-break to the
    // first wire and silently coerce to the fast variant.
    hints.fast = lower.includes('-fast') ? 'true' : 'false';

    if (lower.includes('thinking')) {
        hints.thinking = 'true';
    }

    return hints;
}

function scoreWireAgainstSku(slug: string, wireId: string): number {
    const hints = inferSkuParamHints(slug);
    const params = parseCursorWireParams(wireId);
    let score = 0;

    for (const [key, value] of Object.entries(hints)) {
        if (params[key] === value) {
            score += 2;
        } else if (params[key] !== undefined) {
            score -= 1;
        }
    }

    return score;
}

/** Best-matching CLI sku for highlighting when session state stores an ACP wire id. */
export function findBestCliSkuForAcpWire(
    wireId: string,
    skuIds: readonly string[]
): string | null {
    let best: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const sku of skuIds) {
        const trimmed = sku.trim();
        if (!trimmed || isCursorAcpWireModelId(trimmed)) {
            continue;
        }
        if (matchCliSkuToAcpWireId(trimmed, [{ modelId: wireId }]) !== wireId) {
            continue;
        }
        const score = scoreWireAgainstSku(trimmed, wireId);
        if (score > bestScore) {
            bestScore = score;
            best = trimmed;
        }
    }

    return best;
}

function syntheticSkuFromWireParams(base: string, params: Record<string, string>): string {
    const effort = params.reasoning ?? params.effort ?? 'medium';
    let sku = resolveCursorLegacyModelBase(base);

    if (effort === 'extra-high' || effort === 'xhigh') {
        sku += '-extra-high';
    } else if (effort === 'high') {
        sku += '-high';
    } else if (effort === 'low') {
        sku += '-low';
    } else if (effort === 'medium') {
        sku += '-medium';
    } else if (effort === 'none') {
        sku += '-none';
    }

    if (params.fast === 'true') {
        sku += '-fast';
    }

    return sku;
}

function pseudoWireFromSku(sku: string): string {
    const base = cursorCliSkuBaseId(sku);
    const hints = inferSkuParamHints(sku);
    const parts = Object.entries(hints).map(([key, value]) => `${key}=${value}`);
    return `${base}[${parts.join(',')}]`;
}

function pickBestCatalogSku(
    requestedSku: string,
    available: readonly { modelId: string }[]
): string | null {
    const skuBase = cursorCliSkuBaseId(requestedSku);
    const candidates = available.filter((entry) => {
        const modelId = entry.modelId.trim();
        return modelId && !isCursorAcpWireModelId(modelId) && cursorCliSkuBaseId(modelId) === skuBase;
    });
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return candidates[0].modelId;
    }

    const exact = candidates.find((entry) => entry.modelId === requestedSku);
    if (exact) {
        return exact.modelId;
    }

    const pseudoWire = pseudoWireFromSku(requestedSku);
    const requestedFast = inferSkuParamHints(requestedSku).fast;
    const sameSpeed = candidates.filter(
        (entry) => inferSkuParamHints(entry.modelId).fast === requestedFast
    );
    const rankedCandidates = sameSpeed.length > 0 ? sameSpeed : candidates;

    let best = rankedCandidates[0].modelId;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const entry of rankedCandidates) {
        const score = scoreWireAgainstSku(entry.modelId, pseudoWire);
        if (score > bestScore) {
            bestScore = score;
            best = entry.modelId;
        }
    }
    return best;
}

/** Parse model ids from Cursor `Cannot use this model` stderr (Available models: …). */
export function parseCursorAvailableModelsFromRejection(text: string): string[] {
    const match = text.match(/Available models:\s*([^\n]*)/i);
    if (!match) {
        return [];
    }

    let catalog = match[1].trim();
    const tipIdx = catalog.search(/\s+Tip:/i);
    if (tipIdx !== -1) {
        catalog = catalog.slice(0, tipIdx).trim();
    }

    return catalog
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part.toLowerCase() !== 'auto');
}

/**
 * Remap a stale hub/ACP wire id onto a live Cursor catalog entry.
 * Returns null when no catalog candidate matches.
 */
export function remapStaleCursorModelId(
    requested: string,
    available: readonly { modelId: string }[]
): string | null {
    const trimmed = requested.trim();
    if (!trimmed) {
        return null;
    }

    const exact = available.find((entry) => entry.modelId === trimmed);
    const legacyWire = isCursorAcpWireModelId(trimmed)
        && resolveCursorLegacyModelBase(cursorModelBaseId(trimmed)) !== cursorModelBaseId(trimmed);
    if (exact && !legacyWire) {
        return trimmed;
    }

    if (isCursorAcpWireModelId(trimmed)) {
        const wireBase = cursorModelBaseId(trimmed);
        if (resolveCursorLegacyModelBase(wireBase) === wireBase) {
            return null;
        }
        const syntheticSku = syntheticSkuFromWireParams(
            wireBase,
            parseCursorWireParams(trimmed)
        );
        return pickBestCatalogSku(syntheticSku, available)
            ?? matchCliSkuToAcpWireId(syntheticSku, available);
    }

    const legacyBase = resolveCursorLegacyModelBase(cursorCliSkuBaseId(trimmed));
    if (legacyBase !== cursorCliSkuBaseId(trimmed)) {
        const rewritten = trimmed.replace(cursorCliSkuBaseId(trimmed), legacyBase);
        return pickBestCatalogSku(rewritten, available)
            ?? matchCliSkuToAcpWireId(rewritten, available);
    }

    return null;
}

/**
 * Map UI/CLI model id (wire or slug) onto an ACP configOptions wire id.
 */
export function matchCliSkuToAcpWireId(
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

    if (isCursorAcpWireModelId(trimmed)) {
        if (resolveCursorLegacyModelBase(cursorModelBaseId(trimmed)) !== cursorModelBaseId(trimmed)) {
            return remapStaleCursorModelId(trimmed, available);
        }
        return null;
    }

    const skuBase = cursorCliSkuBaseId(trimmed);
    const wires = available.filter(
        (entry) => isCursorAcpWireModelId(entry.modelId) && cursorModelBaseId(entry.modelId) === skuBase
    );
    if (wires.length === 0) {
        return null;
    }
    if (wires.length === 1) {
        return wires[0].modelId;
    }

    let best = wires[0].modelId;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const entry of wires) {
        const score = scoreWireAgainstSku(trimmed, entry.modelId);
        if (score > bestScore) {
            bestScore = score;
            best = entry.modelId;
        }
    }
    return best;
}
