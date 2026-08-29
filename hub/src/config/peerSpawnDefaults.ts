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

function sanitizeModels(
    models: PeerSpawnDefaults['models'] | undefined
): PeerSpawnDefaults['models'] | undefined {
    if (!models) {
        return undefined
    }
    const allowed = new Set<string>(CREATABLE_AGENT_FLAVORS)
    const sanitized: NonNullable<PeerSpawnDefaults['models']> = {}
    for (const [flavor, model] of Object.entries(models)) {
        if (!allowed.has(flavor)) {
            continue
        }
        const trimmed = model.trim()
        if (trimmed) {
            sanitized[flavor] = trimmed
        }
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined
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
    const nextModels = patch.models !== undefined
        ? { ...existing.models, ...sanitizeModels(patch.models) }
        : existing.models
    return {
        ...existing,
        ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        ...(patch.models !== undefined ? { models: nextModels } : {})
    }
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
