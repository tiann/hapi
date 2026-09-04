import type { AgentFlavor, SpawnModelValidation } from '@hapi/protocol';
import { validateSpawnModelAgainstCatalog } from '@hapi/protocol';
import { getCachedCursorModelIds } from '@/modules/common/cursorModels';

/**
 * Cached-only model catalogs for the spawn preflight. Flavors without a cached
 * catalog return [], which `validateSpawnModelAgainstCatalog` treats as
 * "unknown" and never rejects. Add a flavor here only when its ids can be read
 * without spawning a probe.
 */
function getCachedModelCatalog(agent: AgentFlavor): string[] {
    if (agent === 'cursor') return getCachedCursorModelIds();
    return [];
}

/**
 * Fail-closed guard against spawning a child that would die at agent handshake
 * because the requested model does not exist (e.g. `--agent cursor --model gpt-5`),
 * leaving an archived session with no turns behind.
 */
export function checkSpawnModel(agent: AgentFlavor, model: string | null | undefined): SpawnModelValidation {
    return validateSpawnModelAgainstCatalog(agent, model, getCachedModelCatalog(agent));
}
