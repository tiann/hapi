import { cursorCliSkuBaseId, cursorModelBaseId, resolveCursorLegacyModelBase } from './cursorCliSku'
import type { AgentFlavor } from './modes'

/**
 * Ids that mean "let the agent pick"; never matched against a catalog. Matches
 * the spawn path's own reading of them (see cursorAcpBackend / cursorModeConfig),
 * which is case-insensitive and also accepts the bare wire form `default[]`.
 */
const WILDCARD_MODEL_IDS = new Set(['auto', 'default'])

/** Keeps the rejection message readable when a catalog has dozens of skus. */
const MAX_LISTED_MODELS = 12

export type SpawnModelValidation =
    | { ok: true }
    | { ok: false; message: string }

/**
 * Ids a catalog entry (or a requested model) should be compared under. Cursor
 * ships the same model as an ACP wire id (`composer-2.5[thinking]`) and as CLI
 * skus (`composer-2.5-high-fast`), so both collapse to their base slug.
 */
function catalogCandidates(agent: AgentFlavor, modelId: string): string[] {
    const trimmed = modelId.trim().toLowerCase()
    if (!trimmed) return []
    if (agent !== 'cursor') return [trimmed]
    // Renamed bases (grok-4.5 → cursor-grok-4.5) still reach spawn from stale hub
    // rows and mobile drafts, where cursorStaleModelRemap resolves them; the
    // preflight must not reject what that remap would have fixed.
    const bases = [trimmed, cursorModelBaseId(trimmed), cursorCliSkuBaseId(trimmed)]
    return [...new Set([...bases, ...bases.map(resolveCursorLegacyModelBase)])].filter(Boolean)
}

function isWildcardModelId(agent: AgentFlavor, modelId: string): boolean {
    const trimmed = modelId.trim().toLowerCase()
    const base = agent === 'cursor' ? cursorModelBaseId(trimmed) : trimmed
    return WILDCARD_MODEL_IDS.has(trimmed) || WILDCARD_MODEL_IDS.has(base)
}

export function buildSpawnModelCatalogIndex(agent: AgentFlavor, catalog: readonly string[]): Set<string> {
    const index = new Set<string>()
    for (const entry of catalog) {
        for (const candidate of catalogCandidates(agent, entry)) index.add(candidate)
    }
    return index
}

/**
 * Near-misses first: a rejected `gpt-5` is most usefully answered with the
 * `gpt-5.x` ids, which plain alphabetical order would truncate away.
 *
 * Cursor entries collapse to their base slug — a catalog of ACP wire ids would
 * otherwise spend the whole list on `gpt-5-mini[fast=false]`-style variants of
 * two or three models, and the base slug is itself accepted.
 */
function formatAcceptedModels(agent: AgentFlavor, requested: string, catalog: readonly string[]): string {
    const prefix = requested.toLowerCase()
    const display = (id: string): string => (agent === 'cursor' ? cursorCliSkuBaseId(id) : id)
    const ids = [...new Set(catalog.map((id) => display(id.trim())).filter(Boolean))].sort()
    const ranked = [
        ...ids.filter((id) => id.toLowerCase().startsWith(prefix)),
        ...ids.filter((id) => !id.toLowerCase().startsWith(prefix))
    ]
    const listed = ranked.slice(0, MAX_LISTED_MODELS).join(', ')
    return ranked.length > MAX_LISTED_MODELS ? `${listed}, … (${ranked.length} total)` : listed
}

/**
 * Rejects a spawn model the machine's catalog for this flavor definitely does
 * not contain, so the runner can fail before booting a child that would die at
 * agent handshake and leave an archived session with no turns.
 *
 * The contract is deliberately **base-level**: a model is rejected only when its
 * base appears nowhere in the catalog. Variant-level availability — an effort
 * sku like `gpt-5.5-high-fast`, or a wire with contradictory params like
 * `claude-opus-4-8[thinking=false,effort=high]` — stays the handshake's job,
 * because a cached catalog is not authoritative about variants:
 *
 *   - shared cliModelSkus rows are explicitly partial, unioned with a later
 *     probe (cursorModels: "unions shared partial cliModelSkus with probe
 *     results"), and that probe is skipped entirely while an ACP session holds
 *     the CLI lock, so a missing sku proves nothing;
 *   - a wire-only cache carries no sku naming at all, and a sku-only cache
 *     carries no param sets.
 *
 * Treating absence at variant level as proof would reject valid spawns on every
 * machine whose cache is mid-union or wire-only — a worse failure than the
 * handshake error it would pre-empt.
 *
 * An empty catalog likewise means "this machine could not enumerate models", not
 * "no models exist" — never reject there, or every flavor without a probe would
 * stop accepting valid ids.
 */
export function validateSpawnModelAgainstCatalog(
    agent: AgentFlavor,
    model: string | null | undefined,
    catalog: readonly string[]
): SpawnModelValidation {
    const requested = model?.trim() ?? ''
    if (!requested || isWildcardModelId(agent, requested)) return { ok: true }
    if (catalog.length === 0) return { ok: true }

    const index = buildSpawnModelCatalogIndex(agent, catalog)
    if (catalogCandidates(agent, requested).some((candidate) => index.has(candidate))) return { ok: true }

    return {
        ok: false,
        message: `Model '${requested}' is not in the ${agent} model catalog on this machine. Accepted: ${formatAcceptedModels(agent, requested, catalog)}`
    }
}
