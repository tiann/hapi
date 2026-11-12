import type { PermissionMode } from '@hapi/protocol/types'

export type BerryMode = {
    /** Opaque ACP config-option value (Berry: `provider/model` catalog id).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
    /** HAPI permission mode attached to the outgoing turn. undefined = the
     * session default ('default'). Berry has no agent-side mode axis — the
     * HAPI permission bridge is the only live enforcement and reads the
     * session's mode on every request_permission; this field only rides the
     * turn for display sync. */
    permissionMode?: PermissionMode
    /** Inline image attachments upgraded to ACP image content blocks at
     * prompt time (see utils/berryPromptContent). Part of the mode so the
     * queue's mode hash separates image-carrying turns: collectBatch only
     * keeps the first item's mode, so an image message must never merge
     * into a batch whose mode would silently drop its images. */
    imageAttachments?: BerryImageAttachment[]
}

/** Image attachment metadata traveling with a queued turn. The file is read
 * (authorized per session) only at prompt time, when the backend's
 * advertised image capability is known. */
export type BerryImageAttachment = {
    /** Registered upload path. */
    path: string
    mimeType: string
    filename?: string
}

/** Mode attached to an outgoing turn. The model preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. The permission mode is only
 *  attached once the session state carries one, so ordinary turns stay lean. */
export function berryModeForPreference(
    model: string | null | undefined,
    permissionMode?: PermissionMode
): BerryMode {
    const mode: BerryMode = model === undefined ? {} : { model }
    if (permissionMode !== undefined) {
        mode.permissionMode = permissionMode
    }
    return mode
}
