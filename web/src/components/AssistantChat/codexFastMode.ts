import { codexModelHasUltrafastTier } from '@hapi/protocol'
// Codex Fast mode (service tier) availability is advertised per-model by the
// Codex app-server `model/list` catalog, which is resolved server-side from the
// user's account/auth/plan. An API-key session (no Fast credits) or a model
// without Fast support simply won't list a `fast` service tier. Gating the UI on
// this catalog signal — rather than a model-name heuristic — means the toggle
// only appears when toggling it will actually do something.

type CodexModelCatalogEntry = {
    id: string
    isDefault: boolean
    defaultServiceTier?: string | null
    serviceTiers?: string[]
}

function isFastTierId(tierId: string): boolean {
    return /^(fast|priority)$/i.test(tierId.trim())
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

export function codexModelAdvertisesUltrafastTier(
    sessionModel: string | null | undefined,
    models: ReadonlyArray<CodexModelCatalogEntry>
): boolean {
    return codexModelHasUltrafastTier(findActiveModel(sessionModel, models))
}

export function isFastServiceTier(serviceTier?: string | null): boolean {
    return /^(fast|priority|ultrafast)$/i.test(serviceTier?.trim() ?? '')
}

export function getEffectiveCodexServiceTier(
    serviceTier: string | null | undefined,
    sessionModel: string | null | undefined,
    models: ReadonlyArray<CodexModelCatalogEntry>,
    confirmationPending = false
): string | null | undefined {
    // A null native result means no effective tier. Only an absent report
    // leaves room to display a provisional account default.
    if (confirmationPending) return isFastServiceTier(serviceTier) ? null : serviceTier
    if (serviceTier !== undefined) return serviceTier
    const catalogTier = findActiveModel(sessionModel, models)?.defaultServiceTier
    // Ultrafast requires an effective native confirmation; the account catalog
    // default can still advertise it when the thread feature is disabled.
    return catalogTier?.trim().toLowerCase() === 'ultrafast' ? serviceTier : catalogTier
}

/**
 * Show the untouched tier as Standard. A native-only tier has no matching
 * option, but the user can still choose Standard to reset it.
 */
export function getDisplayedCodexServiceTier(serviceTier?: string | null): 'standard' | 'fast' | 'ultrafast' | null {
    const tier = serviceTier?.trim().toLowerCase()
    if (!tier || tier === 'standard' || tier === 'default') return 'standard'
    if (tier === 'ultrafast') return 'ultrafast'
    return isFastTierId(tier) ? 'fast' : null
}
