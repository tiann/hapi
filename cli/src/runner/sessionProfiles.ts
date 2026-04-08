import type { PermissionMode } from '@hapi/protocol/types'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import { readMachineSessionProfiles } from '@/persistence'

export function resolveSpawnPermissionMode(args: Pick<SpawnSessionOptions, 'permissionMode' | 'yolo'>): PermissionMode {
    if (args.permissionMode) {
        return args.permissionMode
    }
    return args.yolo === true ? 'yolo' : 'default'
}

export async function assertKnownSpawnProfile(
    agent: SpawnSessionOptions['agent'],
    profileId?: string | null
): Promise<void> {
    if (agent !== 'codex' || !profileId) {
        return
    }

    const { profiles } = await readMachineSessionProfiles()
    if (!profiles.some((profile) => profile.id === profileId)) {
        throw new Error('Profile not found')
    }
}

export function buildSpawnProfileEnv(profileId?: string | null): Record<string, string> {
    if (!profileId) {
        return {}
    }
    return {
        HAPI_SESSION_PROFILE_ID: profileId
    }
}

export function buildCodexSpawnModeEnv(permissionMode: PermissionMode): Record<string, string> {
    if (permissionMode === 'default') {
        return {}
    }
    return {
        HAPI_CODEX_PERMISSION_MODE: permissionMode
    }
}
