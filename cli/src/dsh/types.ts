export type DshMode = {
    /** Opaque ACP config-option value (dsh: JSON-encoded provider+model tuple).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
    /** Reasoning-effort preference for the turn ('reasoning_effort' config
     * option, category thought_level). null = the picker's "Default" reset,
     * mapped to DSH's '' (Provider default); undefined = no change. */
    modelReasoningEffort?: string | null
    /** Inline image attachments upgraded to ACP image content blocks at
     * prompt time (see utils/dshPromptContent). Part of the mode so the
     * queue's mode hash separates image-carrying turns: collectBatch only
     * keeps the first item's mode, so an image message must never merge
     * into a batch whose mode would silently drop its images. */
    imageAttachments?: DshImageAttachment[]
}

/** Image attachment metadata traveling with a queued turn. The file is read
 * (authorized per session) only at prompt time, when the backend's advertised
 * image capability is known. */
export type DshImageAttachment = {
    /** Registered upload path. */
    path: string
    mimeType: string
    filename?: string
}

/** Mode attached to an outgoing turn. The session preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. */
export function dshModeForPreference(model: string | null | undefined): DshMode {
    return model === undefined ? {} : { model }
}
