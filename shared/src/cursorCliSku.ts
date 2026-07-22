/** ACP parameterized wire ids use bracket params; CLI `agent --list-models` slugs do not. */
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

/**
 * CLI probe SKUs that carry effort/speed suffixes (e.g. `gpt-5.5-high-fast`).
 * Base-only slugs like `composer-2.5` are not variant SKUs.
 */
export function isCursorCliSkuVariantId(modelId: string): boolean {
    const trimmed = modelId.trim();
    if (!trimmed || isCursorAcpWireModelId(trimmed)) {
        return false;
    }
    return cursorCliSkuBaseId(trimmed) !== trimmed;
}

/**
 * Picker/catalog-eligible ACP model ids.
 * Accepts parameterized wires and bare non-default ACP bases (current Cursor ACP).
 * Rejects CLI effort/speed SKU slugs so they stay variant rows, not top-level bases.
 */
export function isCursorAcpCatalogModelId(modelId: string): boolean {
    const trimmed = modelId.trim();
    if (!trimmed) {
        return false;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'auto' || lower === 'default') {
        return false;
    }
    if (isCursorAcpWireModelId(trimmed)) {
        return true;
    }
    if (isCursorCliSkuVariantId(trimmed)) {
        return false;
    }
    return true;
}

function parseWireParams(modelId: string): Record<string, string> {
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
    const params = parseWireParams(wireId);
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
        return null;
    }

    const skuBase = cursorCliSkuBaseId(trimmed);
    const wires = available.filter(
        (entry) => isCursorAcpCatalogModelId(entry.modelId) && cursorModelBaseId(entry.modelId) === skuBase
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
