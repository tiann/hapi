// Codex Fast mode (service tier) availability is advertised per-model by the
// Codex app-server `model/list` catalog, which is resolved server-side from the
// user's account/auth/plan. An API-key session (no Fast credits) or a model
// without Fast support simply won't list a `fast` service tier. Gating the UI on
// this catalog signal — rather than a model-name heuristic — means the toggle
// only appears when toggling it will actually do something.

type CodexModelCatalogEntry = {
    id: string
    isDefault: boolean
    serviceTiers?: string[]
}

function isFastTierId(tierId: string): boolean {
    return /fast/i.test(tierId.trim())
}

/**
 * Resolve the catalog entry for the session's active model. A null/empty
 * session model means "auto" — the catalog's default model is active.
 */
function findActiveModel<T extends CodexModelCatalogEntry>(
    sessionModel: string | null | undefined,
    models: ReadonlyArray<T>
): T | undefined {
    const normalized = sessionModel?.trim().toLowerCase()
    if (normalized) {
        return models.find((model) => model.id.trim().toLowerCase() === normalized)
    }
    return models.find((model) => model.isDefault)
}

/**
 * True when the session's active Codex model advertises a Fast service tier in
 * the current auth/plan context. Returns false when the catalog is empty/not
 * yet loaded so the toggle stays hidden until we have an authoritative answer.
 */
export function codexModelAdvertisesFastTier(
    sessionModel: string | null | undefined,
    models: ReadonlyArray<CodexModelCatalogEntry>
): boolean {
    if (models.length === 0) {
        return false
    }
    const active = findActiveModel(sessionModel, models)
    return Boolean(active?.serviceTiers?.some(isFastTierId))
}

export function isFastServiceTier(serviceTier?: string | null): boolean {
    return serviceTier?.trim().toLowerCase() === 'fast'
}

export function getDisplayedCodexServiceTier(serviceTier?: string | null): 'standard' | 'fast' {
    return isFastServiceTier(serviceTier) ? 'fast' : 'standard'
}
