/**
 * Capabilities the current runner generation advertises to the hub.
 *
 * `piExistingSessionResume` gates the Pi native-history resume path in
 * hub/src/sync/syncEngine.ts: the runner must be able to hand back an
 * existing native Pi process. The runner declares it at registration
 * (HTTP POST /machines) and again on every socket connect, because the hub
 * merges registration-time runner state only for brand-new machines and the
 * socket heartbeat owns the persisted runner_state afterwards — without the
 * socket-side advertisement, a runner upgraded in place would never get its
 * new capabilities observed by the hub.
 */
export const RUNNER_CAPABILITIES = {
    piExistingSessionResume: true
} as const

export type RunnerCapabilities = typeof RUNNER_CAPABILITIES
