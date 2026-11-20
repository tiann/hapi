// Mount-gate events for the voice backend chunks. Kept in a dependency-free
// module so the requester (voice-context, always loaded) and the responder
// (VoiceBackendSession, inside a lazy chunk) share event names without
// pulling each other into their static import graphs.
export const VOICE_BACKEND_MOUNT_REQUEST_EVENT = 'hapi-voice-backend-mount-request'

/** Dispatched when the selected backend component has mounted and registered its session. */
export const VOICE_BACKEND_READY_EVENT = 'hapi-voice-backend-ready'
