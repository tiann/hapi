import {
    mergePeerSpawnDefaults,
    type PeerSpawnDefaults,
    type ResolvedPeerSpawnDefaults
} from '@hapi/protocol/peerSpawnDefaults'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol/modes'
import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from './settings'

export type { PeerSpawnDefaults, ResolvedPeerSpawnDefaults }

/**
 * Merge a models patch onto stored overrides.
 * Empty / whitespace values clear that flavor’s override (do not keep the prior key).
 */
export function applyPeerSpawnModelsPatch(
    existing: PeerSpawnDefaults['models'] | undefined,
    patch: NonNullable<PeerSpawnDefaults['models']>
): PeerSpawnDefaults['models'] | undefined {
    const allowed = new Set<string>(CREATABLE_AGENT_FLAVORS)
    const next: NonNullable<PeerSpawnDefaults['models']> = { ...(existing ?? {}) }
    for (const [flavor, model] of Object.entries(patch)) {
        if (!allowed.has(flavor)) {
            continue
        }
        const trimmed = model.trim()
        if (!trimmed) {
            delete next[flavor]
        } else {
            next[flavor] = trimmed
        }
    }
    return Object.keys(next).length > 0 ? next : undefined
}

export function readPeerSpawnDefaultsFromSettings(
    settings: Settings
): ResolvedPeerSpawnDefaults {
    return mergePeerSpawnDefaults(settings.peerSpawnDefaults)
}

export async function readPeerSpawnDefaults(dataDir: string): Promise<ResolvedPeerSpawnDefaults> {
    const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
    return readPeerSpawnDefaultsFromSettings(settings)
}

export function applyPeerSpawnDefaultsPatch(
    current: Settings,
    patch: PeerSpawnDefaults
): PeerSpawnDefaults {
    const existing = current.peerSpawnDefaults ?? {}
    const next: PeerSpawnDefaults = {
        ...existing,
        ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {})
    }
    if (patch.models !== undefined) {
        const nextModels = applyPeerSpawnModelsPatch(existing.models, patch.models)
        if (nextModels !== undefined) {
            next.models = nextModels
        } else {
            delete next.models
        }
    }
    return next
}

export async function writePeerSpawnDefaults(
    dataDir: string,
    patch: PeerSpawnDefaults
): Promise<ResolvedPeerSpawnDefaults> {
    return updateSettings(getSettingsFile(dataDir), (current) => {
        const settings: Settings = {
            ...current,
            peerSpawnDefaults: applyPeerSpawnDefaultsPatch(current, patch)
        }
        return {
            settings,
            result: readPeerSpawnDefaultsFromSettings(settings)
        }
    })
}
