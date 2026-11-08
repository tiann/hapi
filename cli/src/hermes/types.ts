import type { PermissionMode } from '@hapi/protocol/types'

export type HermesMode = {
    /** Opaque ACP config-option value (Hermes: `provider:model` picker id).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
    /** HAPI permission mode attached to the outgoing turn. undefined = the
     * session default ('default'); the launcher pushes changes to Hermes via
     * session/set_mode before prompting. */
    permissionMode?: PermissionMode
}

/** Mode attached to an outgoing turn. The model preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. The permission mode is only
 *  attached once the session state carries one, so ordinary turns stay lean. */
export function hermesModeForPreference(
    model: string | null | undefined,
    permissionMode?: PermissionMode
): HermesMode {
    const mode: HermesMode = model === undefined ? {} : { model }
    if (permissionMode !== undefined) {
        mode.permissionMode = permissionMode
    }
    return mode
}
