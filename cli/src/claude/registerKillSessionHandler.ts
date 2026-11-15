import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";
import { DEFAULT_RPC_TIMEOUT_MS, getSessionStopPreparationMethod, RPC_METHODS, type SessionStopPreparationLease } from '@hapi/protocol/rpcMethods';
import { getProcessStartMarker } from '@/utils/process';
import { monotonicTimeMs } from '@/utils/time';

interface KillSessionRequest {
    /** Runner owns process-tree termination after preparation is acknowledged. */
    prepareOnly?: boolean;
    expectedPid?: number;
    expectedProcessStartMarker?: string;
    expectedMachineId?: string;
    preparationLease?: SessionStopPreparationLease;
}

interface KillSessionResponse {
    success: boolean;
    message: string;
    /** OS pid of this CLI — hub uses it to confirm exit via StopSession when maps miss. */
    pid: number;
    /** Generation marker for `pid`; required before the runner will tree-kill it. */
    processStartMarker?: string;
    preparationLease?: SessionStopPreparationLease;
    machineId?: string;
}

/**
 * tiann/hapi#914: callers can pass either a bare `cleanupAndExit` closure
 * (legacy) or an options object that lets the kill-RPC stamp an explicit
 * `archiveReason` before the lifecycle teardown runs. The hub only sends
 * KillSession when the operator clicked Archive in the UI, so this RPC is
 * the authoritative "user-terminated" signal; out-of-band SIGTERM from a
 * hub-restart cascade no longer collides with the default archive reason.
 */
export interface KillSessionLifecycle {
    cleanupAndExit: () => Promise<void>;
    setArchiveReason?: (reason: string) => void;
    /** Complete queued publications before the hub starts runner termination. */
    beforeKill?: (lease?: SessionStopPreparationLease) => Promise<boolean | void>;
    /** Immutable bootstrap identity, independent of later session metadata. */
    machineId?: string;
}

export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    lifecycleOrCleanup: KillSessionLifecycle | (() => Promise<void>),
    session?: {
        hubArchived?: boolean
        on(event: 'hub-archived', listener: () => void): unknown
    }
) {
    const lifecycle: KillSessionLifecycle = typeof lifecycleOrCleanup === 'function'
        ? { cleanupAndExit: lifecycleOrCleanup }
        : lifecycleOrCleanup;
    const machineId = lifecycle.machineId;

    const exitFromHubArchive = () => {
        logger.debug('Hub-archived metadata received; exiting CLI');
        lifecycle.setArchiveReason?.('User terminated');
        void lifecycle.cleanupAndExit();
    };

    const killSession = async (request: KillSessionRequest): Promise<KillSessionResponse> => {
        logger.debug('Kill session request received');
        if (request?.expectedMachineId !== undefined && request.expectedMachineId !== machineId) {
            throw new Error('Session machine does not match shutdown target');
        }
        const processStartMarker = getProcessStartMarker(process.pid) ?? undefined;
        if (request?.expectedPid !== undefined && (request.expectedPid !== process.pid
            || !request.expectedProcessStartMarker || request.expectedProcessStartMarker !== processStartMarker)) {
            throw new Error('Session process generation does not match shutdown target');
        }
        const lease = request?.prepareOnly === true ? request.preparationLease : undefined;
        if (request?.prepareOnly === true && (!lease?.id || !Number.isFinite(lease.expiresAt)
            || lease.expiresAt <= monotonicTimeMs() || lease.expiresAt > monotonicTimeMs() + DEFAULT_RPC_TIMEOUT_MS)) {
            throw new Error('Session shutdown preparation lease is invalid or expired');
        }

        // tiann/hapi#914: stamp the archive reason from the RPC path so the
        // default in `runnerLifecycle.ts` can be reassigned away from
        // 'User terminated'. A hub-restart-cascade SIGTERM does NOT go
        // through this handler — it hits the SIGTERM signal handler — so
        // those archives now stay labelled `'Hub restart'` (the new default).
        lifecycle.setArchiveReason?.('User terminated');

        // The hub follows this ACK with StopSession, whose graceful process
        // deadline can be shorter than a healthy publication drain.
        if (await lifecycle.beforeKill?.(lease) === false || (lease && lease.expiresAt <= monotonicTimeMs())) {
            throw new Error('Session shutdown preparation was not confirmed');
        }

        // This will start the cleanup process
        if (request?.prepareOnly !== true) void lifecycle.cleanupAndExit();

        // Include pid + start marker so archive can ask the runner to verify
        // this exact process generation exited (#1910) — not a reused PID.
        return {
            success: true,
            message: request?.prepareOnly === true ? 'Session shutdown prepared' : 'Killing hapi CLI process',
            pid: process.pid,
            ...(processStartMarker ? { processStartMarker } : {}),
            ...(lease ? { preparationLease: lease } : {}),
            ...(machineId ? { machineId } : {}),
        };
    };
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KillSession, killSession);
    if (machineId && lifecycle.beforeKill) {
        rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(
            getSessionStopPreparationMethod(machineId, process.pid), async (request) => {
                if (request?.prepareOnly !== true || request.expectedMachineId !== machineId || request.expectedPid !== process.pid) {
                    throw new Error('Process-scoped shutdown requires the exact preparation target');
                }
                return killSession(request);
            }
        );
    }

    // #1910: when archive lands as hub metadata (KillSession unreachable),
    // still exit instead of reconnecting forever.
    // #1911 criterion 6: EventEmitter does not replay past emits — if
    // noteHubArchived already latched before this registration, exit now.
    // Still subscribe so a later emit (or a race with the latch write) is covered.
    if (session?.hubArchived) {
        exitFromHubArchive();
    }
    if (session && typeof session.on === 'function') {
        session.on('hub-archived', exitFromHubArchive);
    }
}
