// Mount-gate events for the voice backend chunks. Kept in a dependency-free
// module so the requester (voice-context, always loaded) and the responder
// (VoiceBackendSession, inside a lazy chunk) share event names without
// pulling each other into their static import graphs.
export const VOICE_BACKEND_MOUNT_REQUEST_EVENT = 'hapi-voice-backend-mount-request'

/** Dispatched when the selected backend component has mounted and registered its session. */
export const VOICE_BACKEND_READY_EVENT = 'hapi-voice-backend-ready'

/**
 * Registration epochs. `readyEpoch` increments on every READY dispatch;
 * `staleEpoch` increments whenever the backend selection may have changed
 * (`hapi-voice-backends-refresh`). A registered session is trustworthy only
 * while readyEpoch > staleEpoch — otherwise it may belong to the previous
 * provider and startVoice must wait for a fresh registration.
 */
let readyEpoch = 0
let staleEpoch = 0

export function bumpVoiceBackendReadyEpoch(): void {
    readyEpoch += 1
}

export function markVoiceBackendStale(): void {
    staleEpoch += 1
}

export function voiceBackendEpochs(): { ready: number; stale: number } {
    return { ready: readyEpoch, stale: staleEpoch }
}
