export type DshMode = {
    /** Opaque ACP config-option value (dsh: JSON-encoded provider+model tuple).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
}

/** Mode attached to an outgoing turn. The session preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. */
export function dshModeForPreference(model: string | null | undefined): DshMode {
    return model === undefined ? {} : { model }
}
