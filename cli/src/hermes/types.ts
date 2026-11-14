import type { HermesPermissionMode } from '@hapi/protocol/modes'

export type HermesMode = {
    permissionMode?: HermesPermissionMode
    model?: string | null
}

export function hermesModeForPreference(
    permissionMode: HermesPermissionMode | undefined,
    model: string | null | undefined
): HermesMode {
    const mode: HermesMode = {}
    if (permissionMode) {
        mode.permissionMode = permissionMode
    }
    if (model === null) {
        mode.model = null
    } else if (typeof model === 'string' && model.trim().length > 0) {
        mode.model = model.trim()
    }
    return mode
}
