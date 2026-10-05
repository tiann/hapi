import fs from 'fs/promises';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'os';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { RunnerState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeRunnerState, RunnerLocallyPersistedState, readRunnerState, acquireRunnerLock, releaseRunnerLock } from '@/persistence';
import { getCliArgs } from '@/utils/cliArgs';
import { getProcessStartMarker, isProcessAlive, isWindows, killProcess, killProcessByChildProcess, killProcessTreeByPid } from '@/utils/process';
import { findStopSessionOrphanTargets, reapRunnerSpawnedOrphans } from '@/runner/orphanReap';
import { decideUntrackedRunnerWebhook } from '@/runner/lateRunnerWebhook';
import {
    decideKeepWrapperArchive,
    decideRawPidStop,
    detachSharedRootFromWrapper,
    keepWrapperForSharedSiblings,
    pidHasActiveSharedRoots,
    sessionRegistryBindingState,
    sessionRuntimeHasActiveSiblings,
    trackedSharedWrapperPidsWithSiblings,
    wrapperHasActiveSiblingRoots,
} from '@/runner/sharedSessionStop';
import { PERMISSION_MODES } from '@hapi/protocol/modes';
import { RUNNER_CAPABILITIES } from '@hapi/protocol';
import { withRetry } from '@/utils/time';
import { isRetryableConnectionError } from '@/utils/errorUtils';

import { cleanupRunnerState, getInstalledCliMtimeMs, isRunnerRunningCurrentlyInstalledHappyVersion, stopRunner, waitForRunnerHandoff } from './controlClient';
import { startRunnerControlServer } from './controlServer';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktree';
import { validateWorkspaceDirectory } from './validateWorkspaceDirectory';
import { join } from 'path';
import { buildMachineMetadata } from '@/agent/sessionFactory';
import { resolveWorkspaceRoots } from '@/utils/workspaceRoot';
import { hashRunnerCliApiToken, hashRunnerExtraHeaders } from './runnerIdentity';
import { readRuntimes, runtimeMayBeAlive, runtimeAuthHash } from '@/codex/shared/registry';
import { scheduleCursorModelsPrewarm } from '@/modules/common/cursorModelsPrewarm';
import { isLinkedGitWorktree } from '@/utils/isLinkedGitWorktree';
import { agentUnavailableMessage, getAgentAvailability } from '@/agent/agentAvailability';
import { copyCodexConfigFile, resolveCodexHome } from '@/codex/utils/codexHome';

/**
 * Deduplicates a preallocated HAPI-row spawn only while its child is alive.
 * A lost acknowledgement can retry safely, but a later resume after that
 * child exits must be allowed to start a new child for the same HAPI row.
 */
export type SpawnDeduplicator = ((options: SpawnSessionOptions) => Promise<SpawnSessionResult>) & {
  recoverChild: (existingSessionId: string, result: SpawnSessionResult) => void
  markChildAlive: (existingSessionId: string) => void
  markChildStopping: (existingSessionId: string) => void
  onChildExited: (existingSessionId: string) => void
}

export function createSpawnDeduplicator(
  spawnOnce: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
): SpawnDeduplicator {
  const completedOrInFlight = new Map<string, Promise<SpawnSessionResult>>();
  const childState = new Map<string, 'alive' | 'stopping'>();

  const dedupe = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
    const key = options.existingSessionId;
    if (!key) {
      return await spawnOnce(options);
    }
    const existing = completedOrInFlight.get(key);
    if (existing) {
      return await existing;
    }

    const task = spawnOnce(options);
    completedOrInFlight.set(key, task);
    task.then((result) => {
      // A failure before a PID exists can retry immediately. Once startRunner
      // has registered a child PID, keep its result until exit/stale detection
      // confirms that the child is gone.
      if (result.type !== 'success' && !childState.has(key) && completedOrInFlight.get(key) === task) {
        completedOrInFlight.delete(key);
      }
    }, () => {
      if (!childState.has(key) && completedOrInFlight.get(key) === task) {
        completedOrInFlight.delete(key);
      }
    });
    return await task;
  };
  dedupe.recoverChild = (existingSessionId: string, result: SpawnSessionResult) => {
    childState.set(existingSessionId, 'alive');
    completedOrInFlight.set(existingSessionId, Promise.resolve(result));
  };
  dedupe.markChildAlive = (existingSessionId: string) => {
    childState.set(existingSessionId, 'alive');
  };
  dedupe.markChildStopping = (existingSessionId: string) => {
    if (childState.has(existingSessionId)) {
      childState.set(existingSessionId, 'stopping');
    }
  };
  dedupe.onChildExited = (existingSessionId: string) => {
    childState.delete(existingSessionId);
    completedOrInFlight.delete(existingSessionId);
  };
  return dedupe;
}

export function classifyRecoveredProcessGeneration(
  processAlive: boolean,
  currentMarker: string | null,
  persistedMarker: string
): 'verified' | 'quarantined' | 'exited' {
  if (!processAlive) return 'exited';
  if (currentMarker === null) return 'quarantined';
  return currentMarker === persistedMarker ? 'verified' : 'exited';
}

export function releaseRecoveredSpawnDedupe(
  pid: number,
  existingSessionIdByChildPid: Map<number, string>,
  spawnSession: SpawnDeduplicator
): void {
  const existingSessionId = existingSessionIdByChildPid.get(pid);
  if (!existingSessionId) return;
  spawnSession.onChildExited(existingSessionId);
  existingSessionIdByChildPid.delete(pid);
}

export async function startRunner(options: { workspaceRoots?: string[] } = {}): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[RUNNER RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[RUNNER RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[RUNNER RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[RUNNER RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  if (isWindows()) {
    process.on('SIGBREAK', () => {
      logger.debug('[RUNNER RUN] Received SIGBREAK');
      requestShutdown('os-signal');
    });
  }

  process.on('uncaughtException', (error) => {
    logger.debug('[RUNNER RUN] FATAL: Uncaught exception', error);
    logger.debug(`[RUNNER RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[RUNNER RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[RUNNER RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[RUNNER RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[RUNNER RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[RUNNER RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[RUNNER RUN] Starting runner process...');
  logger.debugLargeJson('[RUNNER RUN] Environment', getEnvironmentInfo());

  // Detect authorized handoff from a parent runner doing the
  // mtime-drift self-restart (see heartbeat block below). The parent sets
  // HAPI_RUNNER_HANDOFF_FROM_PID=<parent_pid> on the spawned child's env;
  // if it matches the live state pid, we are the explicit replacement and
  // must NOT trigger `stopRunner()` (parent will voluntarily release the
  // lock and exit once it sees our pid in state).
  //
  // Codex review #814 [Major] on run.ts:892 -- previously the child
  // unconditionally called `stopRunner()` before acquiring the lock or
  // writing its own state. `/stop` resolved the parent's shutdown,
  // deleted runner.state.json, and released the lock BEFORE the child
  // had committed itself; if the child then failed (lock contention,
  // auth error, anything between stopRunner and writeRunnerState), the
  // machine went offline with no runner at all.
  //
  // New protocol:
  //   - Parent: spawn child with HAPI_RUNNER_HANDOFF_FROM_PID env, then
  //     release lock, then wait for state.pid to change to a different
  //     live pid. On wait-timeout the parent re-acquires the lock and
  //     defers retry; on wait-success the parent clearInterval + exit.
  //   - Child: detect env, skip stopRunner(), skip the version-match
  //     early-exit, acquire the lock with a longer retry window (parent
  //     releases asynchronously, so we may need to wait).
  const handoffFromPidRaw = process.env.HAPI_RUNNER_HANDOFF_FROM_PID;
  const handoffFromPid = handoffFromPidRaw ? Number(handoffFromPidRaw) : NaN;
  let isAuthorizedHandoff = false;
  if (Number.isFinite(handoffFromPid) && handoffFromPid > 0) {
    const existingState = await readRunnerState();
    if (existingState?.pid === handoffFromPid && isProcessAlive(handoffFromPid)) {
      isAuthorizedHandoff = true;
      logger.debug(`[RUNNER RUN] Authorized handoff from parent runner PID ${handoffFromPid}; skipping stopRunner() and version-match short-circuit`);
    } else {
      logger.debug(`[RUNNER RUN] HAPI_RUNNER_HANDOFF_FROM_PID=${handoffFromPidRaw} set but no matching live parent in state (state.pid=${existingState?.pid ?? 'none'}); ignoring handoff signal`);
    }
  }

  if (!isAuthorizedHandoff) {
    // Check if already running
    // Check if running runner version matches current CLI version
    const runningRunnerVersionMatches = await isRunnerRunningCurrentlyInstalledHappyVersion();
    if (!runningRunnerVersionMatches) {
      logger.debug('[RUNNER RUN] Runner version mismatch detected, restarting runner with current CLI version');
      await stopRunner();
    } else {
      logger.debug('[RUNNER RUN] Runner version matches, keeping existing runner');
      console.log('Runner already running with matching version');
      process.exit(0);
    }
  }

  // Acquire exclusive lock (proves runner is running).
  // In authorized-handoff mode the parent is still alive holding the lock
  // and will release it asynchronously once we are spawned, so wait longer
  // (30s) instead of giving up after the standard 1s. Outside handoff,
  // preserve the original 5x200ms = 1s "already running" semantics.
  const lockMaxAttempts = isAuthorizedHandoff ? 60 : 5;
  const lockDelayIncrementMs = isAuthorizedHandoff ? 500 : 200;
  const initialLockHandle = await acquireRunnerLock(lockMaxAttempts, lockDelayIncrementMs);
  if (!initialLockHandle) {
    logger.debug('[RUNNER RUN] Runner lock file already held, another runner is running');
    process.exit(0);
  }
  // `let` because the heartbeat-restart handoff path below may release and
  // re-acquire it. After the null guard above, the initial handle is
  // non-null; the heartbeat path's failure branches either reassign to a
  // re-acquired handle or process.exit() before any subsequent release.
  let runnerLockHandle = initialLockHandle;

  // At this point we should be safe to startup the runner:
  // 1. Not have a stale runner state
  // 2. Should not have another runner process running

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[RUNNER RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    // Retained until actual child exit even if webhook timeout removes normal
    // tracking, so confirmed exit can be attributed to the requested HAPI row.
    const pidToRequestedSessionId = new Map<number, string>();
    const pidToConfirmedSessionId = new Map<number, string>();
    // Generation-local: PIDs whose TrackedSession was dropped by webhook timeout.
    // Late runner webhooks may kill only these — never recovered shared roots
    // that merely appear in resume-processes after a runner restart (#1911).
    const webhookTimeoutOrphanPids = new Set<number>();
    // Only actual observed child exits may create a stop-session tombstone.
    // Tracking loss (notably webhook timeout) is deliberately not evidence.
    const exitTombstoneFile = `${configuration.runnerStateFile}.verified-exits.json`;
    const verifiedExitTombstones = (() => {
      try {
        if (!existsSync(exitTombstoneFile)) return new Set<string>();
        const parsed = JSON.parse(readFileSync(exitTombstoneFile, 'utf8'));
        return new Set<string>(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && !value.startsWith('PID-')) : []);
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to load verified exit tombstones:', error);
        return new Set<string>();
      }
    })();
    // PID aliases are generation-local and must not survive runner restart,
    // because the OS may reuse a PID for an unrelated process.
    const verifiedPidExitTombstones = new Set<string>();
    const persistVerifiedExits = () => {
      const tmp = `${exitTombstoneFile}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify([...verifiedExitTombstones]));
        renameSync(tmp, exitTombstoneFile);
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to persist verified exit tombstones:', error);
      }
    };
    const rememberVerifiedExit = (id: string) => {
      if (id.startsWith('PID-')) {
        verifiedPidExitTombstones.add(id);
        return;
      }
      // Refreshing an existing key should also refresh its insertion order so
      // capacity eviction removes the oldest verified generation.
      verifiedExitTombstones.delete(id);
      verifiedExitTombstones.add(id);
      persistVerifiedExits();
    };
    const hasVerifiedExit = (id: string): boolean => {
      return id.startsWith('PID-')
        ? verifiedPidExitTombstones.has(id)
        : verifiedExitTombstones.has(id);
    };
    const invalidateVerifiedExit = (id: string) => {
      if (id.startsWith('PID-')) {
        verifiedPidExitTombstones.delete(id);
      } else if (verifiedExitTombstones.delete(id)) {
        persistVerifiedExits();
      }
    };

    type PersistedResumeProcess = {
      requestedSessionId: string;
      confirmedSessionId?: string;
      pid: number;
      processStartMarker: string;
    };
    const resumeProcessFile = `${configuration.runnerStateFile}.resume-processes.json`;
    const persistedResumeProcesses = (() => {
      try {
        if (!existsSync(resumeProcessFile)) return new Map<number, PersistedResumeProcess>();
        const parsed = JSON.parse(readFileSync(resumeProcessFile, 'utf8'));
        const records = Array.isArray(parsed) ? parsed : [];
        return new Map<number, PersistedResumeProcess>(records.flatMap((record): Array<[number, PersistedResumeProcess]> => {
          const requestedSessionId = typeof record?.requestedSessionId === 'string'
            ? record.requestedSessionId
            : typeof record?.sessionId === 'string'
              ? record.sessionId
              : null;
          if (!requestedSessionId || typeof record.pid !== 'number' || typeof record.processStartMarker !== 'string') return [];
          return [[record.pid, {
            requestedSessionId,
            confirmedSessionId: typeof record.confirmedSessionId === 'string' ? record.confirmedSessionId : undefined,
            pid: record.pid,
            processStartMarker: record.processStartMarker,
          }]];
        }));
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to load persisted resume processes:', error);
        return new Map<number, PersistedResumeProcess>();
      }
    })();
    const persistResumeProcesses = () => {
      const tmp = `${resumeProcessFile}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify([...persistedResumeProcesses.values()]));
        renameSync(tmp, resumeProcessFile);
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to persist resume processes:', error);
      }
    };
    for (const [pid, record] of [...persistedResumeProcesses]) {
      const alive = isProcessAlive(pid);
      const marker = alive ? getProcessStartMarker(pid) : null;
      const generation = classifyRecoveredProcessGeneration(alive, marker, record.processStartMarker);
      if (generation === 'verified') {
        pidToRequestedSessionId.set(pid, record.requestedSessionId);
        if (record.confirmedSessionId) pidToConfirmedSessionId.set(pid, record.confirmedSessionId);
      } else if (generation === 'exited') {
        persistedResumeProcesses.delete(pid);
        rememberVerifiedExit(record.requestedSessionId);
        if (record.confirmedSessionId) rememberVerifiedExit(record.confirmedSessionId);
      } else {
        // PID is live but generation probing failed: keep the durable record and
        // fail closed instead of manufacturing verified-exit evidence.
        logger.debug(`[RUNNER RUN] Could not verify process generation for PID ${pid}; keeping persisted resume quarantine`);
      }
    }
    persistResumeProcesses();

    // Webhook timeout tolerance. Opus 1M + --resume can legitimately take
    // longer than the default 15s to reach the "Session started" webhook
    // (observed real-world durations of 30s – 60min under rate-limit /
    // heavy session restore). Allow advanced users to raise this ceiling
    // so that slow starts no longer leave orphaned child processes which
    // later report back as ghost sessions.
    const envWebhookTimeout = Number(process.env.HAPI_RUNNER_WEBHOOK_TIMEOUT_MS);
    const webhookTimeoutMs =
      Number.isFinite(envWebhookTimeout) && envWebhookTimeout > 0
        ? envWebhookTimeout
        : 15_000;

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToErrorAwaiter = new Map<number, (errorMessage: string) => void>();
    // existingSessionId identifies the HAPI row, not a permanent spawn request.
    // Keep the dedupe entry only while this runner still owns the child PID.
    const existingSessionIdByChildPid = new Map<number, string>();
    type SpawnFailureDetails = {
      message: string
      pid?: number
      exitCode?: number | null
      signal?: NodeJS.Signals | null
    };
    let reportSpawnOutcomeToHub: ((outcome: { type: 'success' } | { type: 'error'; details: SpawnFailureDetails }) => void) | null = null;
    const formatSpawnError = (error: unknown): string => {
      if (error instanceof Error) {
        return error.message;
      }
      return String(error);
    };

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values()).flatMap(session => session.sharedSessions
      ? Object.entries(session.sharedSessions).map(([happySessionId, metadata]) => ({ ...session, happySessionId, happySessionMetadataFromLocalWebhook: metadata }))
      : [session]);

    // Handle webhook from HAPI session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[RUNNER RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[RUNNER RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[RUNNER RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[RUNNER RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (runner-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && sessionMetadata.capabilities?.concurrentClients) {
        existingSession.sharedSessions ??= {};
        if (sessionMetadata.lifecycleState === 'archived') {
          delete existingSession.sharedSessions[sessionId];
          return;
        }
        existingSession.sharedSessions[sessionId] = sessionMetadata;
        invalidateVerifiedExit(sessionId);
        // Native /new or /fork cannot replace the primary spawn confirmation.
        if (existingSession.happySessionId && existingSession.happySessionId !== sessionId) return;
      }

      if (existingSession && existingSession.startedBy === 'runner') {
        // Update runner-spawned session with reported data
        invalidateVerifiedExit(sessionId);
        invalidateVerifiedExit(`PID-${pid}`);
        existingSession.happySessionId = sessionId;
        pidToConfirmedSessionId.set(pid, sessionId);
        const persisted = persistedResumeProcesses.get(pid);
        if (persisted) {
          persisted.confirmedSessionId = sessionId;
          persistResumeProcesses();
        } else {
          // Fresh Claude/etc. spawns often have no reserved HAPI id at spawn
          // time, so nothing was persisted then. Once the webhook names the
          // row, keep a durable PID mapping so stopSession can still reap
          // after in-memory tracking is dropped (#1910).
          const processStartMarker = getProcessStartMarker(pid);
          if (processStartMarker) {
            persistedResumeProcesses.set(pid, {
              requestedSessionId: existingSession.requestedHappySessionId ?? sessionId,
              confirmedSessionId: sessionId,
              pid,
              processStartMarker
            });
            persistResumeProcesses();
          }
        }
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[RUNNER RUN] Updated runner-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          pidToErrorAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[RUNNER RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // No tracked session for this PID. Two possibilities:
        //  1. The child was spawned externally from a terminal (legitimate).
        //  2. The child was runner-spawned but already had its tracking
        //     entry removed because its webhook arrived after the timeout
        //     (orphaned / ghost-session case).
        //
        // Differentiate via the webhook's own `startedBy` field: genuine
        // terminal-launched children report `startedBy: 'terminal'`, so
        // anything claiming `'runner'` here must be the second case and
        // should be ignored + terminated instead of silently promoted.
        if (sessionMetadata.startedBy === 'runner') {
          // Untracked runner-spawned webhook: either this generation timed the
          // spawn out, or the runner restarted before the webhook (no stamp).
          // Shared Codex must never be killed here (siblings). Nonshared
          // post-restart CLIs must be adopted so StopSession can find them —
          // Claude often has no HAPI id on argv yet (#1910 / #1911).
          const timedOutByThisRunner = webhookTimeoutOrphanPids.has(pid);
          webhookTimeoutOrphanPids.delete(pid);
          const decision = decideUntrackedRunnerWebhook({
            concurrentClients: Boolean(sessionMetadata.capabilities?.concurrentClients),
            timedOutByThisRunner,
          });
          if (decision === 'kill') {
            logger.debug(
              `[RUNNER RUN] Ignoring late webhook from orphaned runner-spawned PID ${pid} (session ${sessionId}). Terminating child.`
            );
            // Use killProcess (SIGTERM → SIGKILL escalation) rather than a
            // bare process.kill() so the orphan is reliably reaped even if
            // it ignores SIGTERM. We don't have a ChildProcess reference
            // here (tracking entry was already removed by the timeout
            // handler), so tree-kill via killProcessByChildProcess is not
            // available — but the timeout handler should have already
            // tree-killed the process group; this is defence-in-depth.
            void killProcess(pid);
            return;
          }

          const processStartMarker = getProcessStartMarker(pid);
          const adopted: TrackedSession = {
            ...(sessionMetadata.capabilities?.concurrentClients
              ? { sharedSessions: { [sessionId]: sessionMetadata } }
              : {}),
            startedBy: 'runner',
            happySessionId: sessionId,
            happySessionMetadataFromLocalWebhook: sessionMetadata,
            pid,
          };
          invalidateVerifiedExit(sessionId);
          invalidateVerifiedExit(`PID-${pid}`);
          pidToTrackedSession.set(pid, adopted);
          pidToConfirmedSessionId.set(pid, sessionId);
          if (processStartMarker) {
            persistedResumeProcesses.set(pid, {
              requestedSessionId: sessionId,
              confirmedSessionId: sessionId,
              pid,
              processStartMarker,
            });
            persistResumeProcesses();
          }
          logger.debug(
            `[RUNNER RUN] Adopted untracked runner-spawned session ${sessionId} (PID ${pid}) after restart or shared recovery`
          );
          return;
        }

        // New session started externally (terminal)
        const trackedSession: TrackedSession = {
          ...(sessionMetadata.capabilities?.concurrentClients ? { sharedSessions: { [sessionId]: sessionMetadata } } : {}),
          startedBy: 'hapi directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        invalidateVerifiedExit(sessionId);
        invalidateVerifiedExit(`PID-${pid}`);
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[RUNNER RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    let spawnSession!: SpawnDeduplicator;
    const spawnSessionOnce = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[RUNNER RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      const agent = options.agent ?? 'claude';
      const availability = getAgentAvailability(agent);
      if (!availability.available) {
        const errorMessage = agentUnavailableMessage(availability);
        logger.debug(`[RUNNER RUN] Agent preflight failed: ${errorMessage}`);
        reportSpawnOutcomeToHub?.({
          type: 'error',
          details: { message: errorMessage }
        });
        return {
          type: 'error',
          errorMessage,
          code: 'agent_unavailable',
          agent,
          childStarted: false,
        };
      }
      if (options.validateDirectory && !(await options.validateDirectory(directory))) {
        return {
          type: 'error',
          errorMessage: 'Directory is outside this machine\'s workspace roots',
          code: 'outside_workspace_roots',
          childStarted: false,
        };
      }
      const yolo = options.yolo === true;
      const sessionType = options.sessionType ?? 'simple';
      const worktreeName = options.worktreeName;
      let directoryCreated = false;
      let spawnDirectory = directory;
      let worktreeInfo: WorktreeInfo | null = null;
      let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;
      let copiedCodexConfigPath: string | null = null;

      const cleanupCopiedCodexConfig = async (reason: string): Promise<void> => {
        const configPath = copiedCodexConfigPath;
        copiedCodexConfigPath = null;
        if (!configPath) {
          return;
        }
        try {
          await fs.rm(configPath, { force: true });
          logger.debug(`[RUNNER RUN] Removed temporary Codex config after ${reason}`);
        } catch (error) {
          logger.debug(`[RUNNER RUN] Failed to remove temporary Codex config after ${reason}`, error);
        }
      };

      if (sessionType === 'simple') {
        const validation = await validateWorkspaceDirectory(directory, {
          approvedNewDirectoryCreation
        });
        if (validation.type === 'requestApproval') {
          logger.debug(`[RUNNER RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory,
            childStarted: false,
          };
        }
        if (validation.type === 'error') {
          logger.debug(`[RUNNER RUN] Workspace directory validation failed: ${validation.errorMessage}`);
          return {
            type: 'error',
            errorMessage: validation.errorMessage,
            childStarted: false,
          };
        }
        directoryCreated = validation.created;
        if (validation.created) {
          logger.debug(`[RUNNER RUN] Successfully created directory: ${directory}`);
        } else {
          logger.debug(`[RUNNER RUN] Directory exists: ${directory}`);
        }
      } else {
        try {
          await fs.access(directory);
          logger.debug(`[RUNNER RUN] Worktree base directory exists: ${directory}`);
        } catch (error) {
          logger.debug(`[RUNNER RUN] Worktree base directory missing: ${directory}`);
          return {
            type: 'error',
            errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`,
            childStarted: false,
          };
        }
      }

      // Re-check after mkdir/access so a newly materialized path or concurrent
      // symlink swap cannot escape the roots checked by the machine RPC layer.
      if (options.validateDirectory && !(await options.validateDirectory(directory))) {
        logger.debug(`[RUNNER RUN] Workspace directory escaped roots during validation: ${directory}`);
        return {
          type: 'error',
          errorMessage: 'Directory is outside this machine\'s workspace roots',
          code: 'outside_workspace_roots',
          childStarted: false,
        };
      }

      if (sessionType === 'worktree') {
        // Cursor Agent has native `--worktree` under ~/.cursor/worktrees/. Prefer that
        // over HAPI's sibling-directory worktree so Cursor sandbox/skills see the same layout.
        // Exception: if `directory` is already a linked git worktree (e.g. HAPI feature
        // worktree or driver/), nesting `--cursor-worktree` hangs ACP initialize (#1085).
        if (agent === 'cursor') {
          spawnDirectory = directory;
          if (isLinkedGitWorktree(directory)) {
            logger.debug(
              `[RUNNER RUN] Directory is already a linked git worktree; skipping Cursor --worktree (cwd=${directory})`
            );
          } else {
            logger.debug(`[RUNNER RUN] Cursor-native worktree requested (nameHint=${worktreeName ?? '(auto)'})`);
          }
        } else {
          const worktreeResult = await createWorktree({
            basePath: directory,
            nameHint: worktreeName
          });
          if (!worktreeResult.ok) {
            logger.debug(`[RUNNER RUN] Worktree creation failed: ${worktreeResult.error}`);
            return {
              type: 'error',
              errorMessage: worktreeResult.error,
              childStarted: false,
            };
          }
          worktreeInfo = worktreeResult.info;
          spawnDirectory = worktreeInfo.worktreePath;
          logger.debug(`[RUNNER RUN] Created worktree ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch})`);
        }
      }

      const cleanupWorktree = async () => {
        if (!worktreeInfo) {
          return;
        }
        const result = await removeWorktree({
          repoRoot: worktreeInfo.basePath,
          worktreePath: worktreeInfo.worktreePath
        });
        if (!result.ok) {
          logger.debug(`[RUNNER RUN] Failed to remove worktree ${worktreeInfo.worktreePath}: ${result.error}`);
        }
      };
      const maybeCleanupWorktree = async (reason: string) => {
        if (!worktreeInfo) {
          return;
        }
        const pid = happyProcess?.pid;
        if (pid && isProcessAlive(pid)) {
          logger.debug(`[RUNNER RUN] Skipping worktree cleanup after ${reason}; child still running`, {
            pid,
            worktreePath: worktreeInfo.worktreePath
          });
          return;
        }
        await cleanupWorktree();
      };

      try {

        // Resolve authentication token if provided
        let extraEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'hapi-codex-'));

            // Preserve user MCP/config settings while keeping token auth isolated.
            copiedCodexConfigPath = await copyCodexConfigFile(resolveCodexHome(), codexHomeDir);

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir, 'auth.json'), options.token);

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexHomeDir
            };
          } else if (options.agent === 'claude' || !options.agent) {
            extraEnv = {
              CLAUDE_CODE_OAUTH_TOKEN: options.token
            };
          }
        }

        if (worktreeInfo) {
          extraEnv = {
            ...extraEnv,
            HAPI_WORKTREE_BASE_PATH: worktreeInfo.basePath,
            HAPI_WORKTREE_BRANCH: worktreeInfo.branch,
            HAPI_WORKTREE_NAME: worktreeInfo.name,
            HAPI_WORKTREE_PATH: worktreeInfo.worktreePath,
            HAPI_WORKTREE_CREATED_AT: String(worktreeInfo.createdAt)
          };
        }

        const args = buildCliArgs(agent, options, yolo);

        // sessionId reserved for future use
        const MAX_TAIL_CHARS = 4000;
        let stderrTail = '';
        const appendTail = (current: string, chunk: Buffer | string): string => {
          const text = chunk.toString();
          if (!text) {
            return current;
          }
          const combined = current + text;
          return combined.length > MAX_TAIL_CHARS ? combined.slice(-MAX_TAIL_CHARS) : combined;
        };
        const logStderrTail = () => {
          const trimmed = stderrTail.trim();
          if (!trimmed) {
            return;
          }
          logger.debug('[RUNNER RUN] Child stderr tail', trimmed);
        };

        happyProcess = spawnHappyCLI(args, {
          cwd: spawnDirectory,
          detached: true,  // Sessions stay alive when runner stops
          stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
          env: {
            ...process.env,
            ...extraEnv
          }
        });
        happyProcess.once('exit', () => {
          void cleanupCopiedCodexConfig('child-exit');
        });

        happyProcess.stderr?.on('data', (data) => {
          stderrTail = appendTail(stderrTail, data);
        });

        let spawnErrorBeforePidCheck: Error | null = null;
        const captureSpawnErrorBeforePidCheck = (error: Error) => {
          spawnErrorBeforePidCheck = error;
        };
        happyProcess.once('error', captureSpawnErrorBeforePidCheck);

        if (!happyProcess.pid) {
          // Allow the async 'error' event to fire before we read it
          await new Promise((resolve) => setImmediate(resolve));
          const details = [`cwd=${spawnDirectory}`];
          if (spawnErrorBeforePidCheck) {
            details.push(formatSpawnError(spawnErrorBeforePidCheck));
          }
          const errorMessage = `Failed to spawn HAPI process - no PID returned (${details.join('; ')})`;
          logger.debug('[RUNNER RUN] Failed to spawn process - no PID returned', spawnErrorBeforePidCheck ?? null);
          reportSpawnOutcomeToHub?.({
            type: 'error',
            details: {
              message: errorMessage
            }
          });
          await cleanupCopiedCodexConfig('no-pid');
          await maybeCleanupWorktree('no-pid');
          return {
            type: 'error',
            errorMessage
          };
        }
        happyProcess.removeListener('error', captureSpawnErrorBeforePidCheck);

        // The OS process now exists, so this is the point where a new generation
        // invalidates exit evidence left by an older child with the same HAPI ID.
        for (const id of [options.sessionId, options.existingSessionId, options.reservedSessionId]) {
          if (id) invalidateVerifiedExit(id);
        }

        const pid = happyProcess.pid;
        const trackHubId = options.existingSessionId ?? options.reservedSessionId;
        if (trackHubId) {
          existingSessionIdByChildPid.set(pid, trackHubId);
          spawnSession.markChildAlive(trackHubId);
        }
        invalidateVerifiedExit(`PID-${pid}`);
        logger.debug(`[RUNNER RUN] Spawned process with PID ${pid}`);
        let observedExitCode: number | null = null;
        let observedExitSignal: NodeJS.Signals | null = null;
        const buildWebhookFailureMessage = (reason: 'timeout' | 'exit-before-webhook' | 'process-error-before-webhook'): string => {
          let message = '';
          if (reason === 'exit-before-webhook') {
            message = `Session process exited before webhook for PID ${pid}`;
          } else if (reason === 'process-error-before-webhook') {
            message = `Session process error before webhook for PID ${pid}`;
          } else {
            message = `Session webhook timeout for PID ${pid}`;
          }

          if (observedExitCode !== null || observedExitSignal) {
            if (observedExitCode !== null) {
              message += ` (exit code ${observedExitCode})`;
            } else {
              message += ` (signal ${observedExitSignal})`;
            }
          }

          const trimmedTail = stderrTail.trim();
          if (trimmedTail) {
            const compactTail = trimmedTail.replace(/\s+/g, ' ');
            const tailForMessage = compactTail.length > 800 ? compactTail.slice(-800) : compactTail;
            message += `. stderr: ${tailForMessage}`;
          }

          return message;
        };

        const trackedSession: TrackedSession = {
          startedBy: 'runner',
          pid,
          requestedHappySessionId: options.existingSessionId ?? options.reservedSessionId ?? options.sessionId,
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };

        pidToTrackedSession.set(pid, trackedSession);
        if (trackedSession.requestedHappySessionId) {
          pidToRequestedSessionId.set(pid, trackedSession.requestedHappySessionId);
          const processStartMarker = getProcessStartMarker(pid);
          if (processStartMarker) {
            persistedResumeProcesses.set(pid, {
              requestedSessionId: trackedSession.requestedHappySessionId,
              pid,
              processStartMarker
            });
            persistResumeProcesses();
          }
        }

        happyProcess.on('exit', (code, signal) => {
          observedExitCode = typeof code === 'number' ? code : null;
          observedExitSignal = signal ?? null;
          logger.debug(`[RUNNER RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
          if (code !== 0 || signal) {
            logStderrTail();
          }
          const errorAwaiter = pidToErrorAwaiter.get(pid);
          if (errorAwaiter) {
            pidToErrorAwaiter.delete(pid);
            pidToAwaiter.delete(pid);
            errorAwaiter(buildWebhookFailureMessage('exit-before-webhook'));
          }
          onChildExited(pid);
        });

        happyProcess.on('error', (error) => {
          logger.debug(`[RUNNER RUN] Child process error:`, error);
          const errorAwaiter = pidToErrorAwaiter.get(pid);
          if (errorAwaiter) {
            pidToErrorAwaiter.delete(pid);
            pidToAwaiter.delete(pid);
            errorAwaiter(buildWebhookFailureMessage('process-error-before-webhook'));
          }
          // A ChildProcess error is not itself proof that the OS process exited.
          // Keep tracking a live PID so machine StopSession can still terminate it.
          if (!isProcessAlive(pid)) onChildExited(pid);
        });

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[RUNNER RUN] Waiting for session webhook for PID ${pid}`);

        const spawnResult = await new Promise<SpawnSessionResult>((resolve) => {
          // Set timeout for webhook. Default is 15s but can be raised via
          // HAPI_RUNNER_WEBHOOK_TIMEOUT_MS for users on slow models
          // (e.g. opus[1m] --resume).
          const timeout = setTimeout(() => {
            void (async () => {
              pidToAwaiter.delete(pid);
              pidToErrorAwaiter.delete(pid);

              // Remove the tracked session entry so a late-arriving webhook
              // from this orphaned PID cannot be silently promoted into a
              // ghost session by onHappySessionWebhook(). Keep durable
              // resume-process / requested-id maps until the process is
              // proven dead so StopSession can still target this PID (#1910).
              pidToTrackedSession.delete(pid);
              webhookTimeoutOrphanPids.add(pid);

              // Await tree-kill (wrapper + agent grandchildren). Do not fire-
              // and-forget: under load an unawaited kill can fail silently and
              // leave an immortal detached child.
              let treeDead = false;
              if (happyProcess) {
                try {
                  treeDead = await killProcessByChildProcess(happyProcess);
                } catch (error) {
                  logger.debug(`[RUNNER RUN] Webhook-timeout tree-kill failed for PID ${pid}:`, error);
                }
              }
              if (!treeDead && isProcessAlive(pid)) {
                try {
                  treeDead = await killProcessTreeByPid(pid);
                } catch (error) {
                  logger.debug(`[RUNNER RUN] Webhook-timeout PID tree-kill failed for ${pid}:`, error);
                }
              }

              if (!isProcessAlive(pid)) {
                if (trackedSession.requestedHappySessionId) {
                  rememberVerifiedExit(trackedSession.requestedHappySessionId);
                }
                rememberVerifiedExit(`PID-${pid}`);
                pidToRequestedSessionId.delete(pid);
                pidToConfirmedSessionId.delete(pid);
                webhookTimeoutOrphanPids.delete(pid);
                if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
                releaseRecoveredSpawnDedupe(pid, existingSessionIdByChildPid, spawnSession);
              }

              await cleanupCopiedCodexConfig('webhook-timeout');

              // If this was a worktree session, the worktree can only be
              // safely removed after the child has actually exited.
              if (worktreeInfo && happyProcess) {
                happyProcess.once('exit', () => {
                  void cleanupWorktree();
                });
                if (!isProcessAlive(pid)) {
                  void cleanupWorktree();
                }
              }

              logger.debug(`[RUNNER RUN] Session webhook timeout for PID ${pid}`);
              logStderrTail();
              resolve({
                type: 'error',
                errorMessage: buildWebhookFailureMessage('timeout')
              });
            })();
          }, webhookTimeoutMs);

          // Register awaiter
          pidToAwaiter.set(pid, (completedSession) => {
            clearTimeout(timeout);
            pidToErrorAwaiter.delete(pid);
            logger.debug(`[RUNNER RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            resolve({
              type: 'success',
              sessionId: completedSession.happySessionId!
            });
          });
          pidToErrorAwaiter.set(pid, (errorMessage) => {
            clearTimeout(timeout);
            resolve({
              type: 'error',
              errorMessage
            });
          });
        });
        if (spawnResult.type === 'error') {
          reportSpawnOutcomeToHub?.({
            type: 'error',
            details: {
              message: spawnResult.errorMessage,
              pid,
              exitCode: observedExitCode,
              signal: observedExitSignal
            }
          });
          await maybeCleanupWorktree('spawn-error');
        } else {
          reportSpawnOutcomeToHub?.({ type: 'success' });
        }
        return spawnResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[RUNNER RUN] Failed to spawn session:', error);
        await cleanupCopiedCodexConfig('exception');
        await maybeCleanupWorktree('exception');
        reportSpawnOutcomeToHub?.({
          type: 'error',
          details: {
            message: `Failed to spawn session: ${errorMessage}`
          }
        });
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    spawnSession = createSpawnDeduplicator(spawnSessionOnce);
    for (const [pid, record] of persistedResumeProcesses) {
      const verified = pidToRequestedSessionId.get(pid) === record.requestedSessionId;
      existingSessionIdByChildPid.set(pid, record.requestedSessionId);
      spawnSession.recoverChild(
        record.requestedSessionId,
        verified && record.confirmedSessionId
          ? { type: 'success', sessionId: record.confirmedSessionId }
          : { type: 'error', errorMessage: `Session ${record.requestedSessionId} process verification is pending` }
      );
    }

    // Stop a session by sessionId or PID fallback
    const stopSession = async (
      sessionId: string,
      opts?: { processStartMarker?: string }
    ): Promise<'stopped' | 'already_gone' | 'still_alive' | 'unknown'> => {
      logger.debug(`[RUNNER RUN] Attempting to stop session ${sessionId}`);

      // After a mapped/persisted PID path succeeds, still scan argv for other
      // generations of the same HAPI id (untracked orphans from an earlier
      // runner) before reporting stopped/already_gone (#1910). Skip only PIDs
      // that still host active shared siblings — never skip the whole scan.
      // Protect tracked wrappers even when the durable runtime registry is
      // missing/unreadable (argv would otherwise match the primary session id).
      const shouldSkipOrphanPid = (
        liveRuntimes: Parameters<typeof wrapperHasActiveSiblingRoots>[0],
        protectedTrackedPids: Set<number>,
        id: string,
        pid: number
      ): boolean => (
        protectedTrackedPids.has(pid)
        || wrapperHasActiveSiblingRoots(liveRuntimes, id, pid)
      );

      // Strict registry read for sibling protection — soft [] after parse/readdir
      // failure would tree-kill a shared wrapper hosting live roots (#1911 Opus).
      // Fail-closed only for Codex stop contexts; other flavors must not become
      // permanently un-archivable on a single corrupt runtime JSON (#1911 Major).
      const isCodexStopContext = (): boolean => {
        for (const [, session] of pidToTrackedSession) {
          if (session.sharedSessions?.[sessionId]) return true
        }
        return false
      }

      const readLiveRuntimesForStop = async () => {
        try {
          return (await readRuntimes({ strict: true })).filter(runtime =>
            runtime.hub === configuration.apiUrl
            && runtime.authHash === runtimeAuthHash()
            && runtimeMayBeAlive(runtime)
          );
        } catch (error) {
          logger.warn(
            `[RUNNER RUN] Codex runtime registry unreadable during stop of ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          // KillSession PID-* fallback cannot prove the OS pid is not a shared
          // Codex wrapper when the registry is unreadable — soft [] would
          // tree-kill sibling roots (#1911 Overseer B2).
          if (sessionId.startsWith('PID-')) return null;
          // findRuntime also soft-fails; if a shared Codex root may still exist,
          // refuse the orphan sweep. Non-Codex stops proceed with [] so archive
          // is not machine-wide blocked by schema drift.
          try {
            const { findRuntime } = await import('@/codex/shared/registry');
            if (await findRuntime(sessionId) || isCodexStopContext()) return null;
          } catch {
            if (isCodexStopContext()) return null;
          }
          return [];
        }
      };

      const finishWithOrphanSweep = async (
        base: 'stopped' | 'already_gone' | 'unknown'
      ): Promise<'stopped' | 'already_gone' | 'still_alive' | 'unknown'> => {
        const liveRuntimes = await readLiveRuntimesForStop();
        if (liveRuntimes === null) return 'still_alive';
        const protectedTrackedPids = trackedSharedWrapperPidsWithSiblings(
          pidToTrackedSession.entries(),
          sessionId
        );
        const orphanStatus = await reapRunnerSpawnedOrphans(sessionId, {
          findTargets: (id) => findStopSessionOrphanTargets(
            id,
            (sid, pid) => shouldSkipOrphanPid(liveRuntimes, protectedTrackedPids, sid, pid)
          ),
        });
        if (orphanStatus === 'still_alive') {
          logger.debug(`[RUNNER RUN] Orphan argv sweep left live PIDs for session ${sessionId}`);
          return 'still_alive';
        }
        if (orphanStatus === 'stopped') {
          rememberVerifiedExit(sessionId);
          return 'stopped';
        }
        return base;
      };

      const { findRuntime } = await import('@/codex/shared/registry');
      const sharedRuntime = await findRuntime(sessionId);
      if (sharedRuntime) {
        try {
          const { runtimeControl } = await import('@/codex/shared/frontend');
          await runtimeControl(sharedRuntime, 'hapi/stopSession', sessionId);
          const tracked = pidToTrackedSession.get(sharedRuntime.pid);
          if (tracked) {
            const detach = detachSharedRootFromWrapper(tracked, sessionId);
            if (detach.kind === 'keep_wrapper' || keepWrapperForSharedSiblings(tracked, sessionId)) {
              // App-server ended this root; sibling roots still need the wrapper.
              // Still argv-sweep other generations; PID filter skips this wrapper.
              logger.debug(
                `[RUNNER RUN] Shared runtime stopped root ${sessionId}; wrapper PID ${sharedRuntime.pid} kept`
              );
              return await finishWithOrphanSweep('stopped');
            }
          }
          // Post-restart: TrackedSession may be gone; registry still lists siblings.
          const liveAfterStop = await readLiveRuntimesForStop();
          if (liveAfterStop === null) return 'still_alive';
          if (wrapperHasActiveSiblingRoots(liveAfterStop, sessionId, sharedRuntime.pid)) {
            logger.debug(
              `[RUNNER RUN] Shared runtime stopped root ${sessionId}; registry siblings keep PID ${sharedRuntime.pid}`
            );
            return await finishWithOrphanSweep('stopped');
          }
          return await finishWithOrphanSweep('stopped');
        } catch { return 'still_alive'; }
      }
      {
        const probeRuntimes = await readLiveRuntimesForStop();
        if (probeRuntimes === null) return 'still_alive';
        if (probeRuntimes.some(runtime => runtime.sessions[sessionId]?.active)) return 'still_alive';
      }

      // Live Codex runtimes for this hub — used when in-memory sharedSessions
      // only knows the root being archived (post-restart adoption of a new root
      // while older roots remain active only in the durable registry).
      const liveRegistryRuntimes = async () => readLiveRuntimesForStop();
      const registrySiblingsKeepPid = async (pid: number): Promise<boolean | 'unreadable'> => {
        const live = await liveRegistryRuntimes();
        if (live === null) return 'unreadable';
        return wrapperHasActiveSiblingRoots(live, sessionId, pid);
      };

      // KillSession pid fallback must verify the start marker BEFORE any tracked
      // PID match can tree-kill a reused OS pid.
      if (sessionId.startsWith('PID-')) {
        const pid = parseInt(sessionId.slice(4), 10);
        if (Number.isFinite(pid) && pid > 0) {
          const liveForPid = await liveRegistryRuntimes();
          if (liveForPid === null) return 'still_alive';
          const decision = decideRawPidStop({
            alive: isProcessAlive(pid),
            expectedMarker: opts?.processStartMarker,
            currentMarker: getProcessStartMarker(pid),
            hasActiveSharedRoots: pidHasActiveSharedRoots(liveForPid, pid),
          });
          if (decision === 'already_gone') {
            rememberVerifiedExit(sessionId);
            return 'already_gone';
          }
          if (decision === 'unknown') {
            logger.debug(
              `[RUNNER RUN] Raw PID ${pid} stop unconfirmed (missing/mismatched start marker or probe failed)`
            );
            return 'unknown';
          }
          if (decision === 'keep_shared') {
            logger.debug(
              `[RUNNER RUN] PID ${pid} still hosts active shared roots; not tree-killing`
            );
            return await finishWithOrphanSweep('stopped');
          }
          if (!(await killProcessTreeByPid(pid))) return 'still_alive';
          rememberVerifiedExit(sessionId);
          return await finishWithOrphanSweep('stopped');
        }
        return 'unknown';
      }

      // After KillSession, findRuntime may miss an inactive binding. Detach the
      // root from sharedSessions without tree-killing siblings. An inactive
      // registry binding is stop evidence (Codex KillSession already archived
      // the root); absent evidence stays unknown across retries.
      const finishKeepWrapperDetach = async (pid: number): Promise<'stopped' | 'already_gone' | 'still_alive' | 'unknown'> => {
        const live = await liveRegistryRuntimes();
        if (live === null) return 'still_alive';
        const binding = sessionRegistryBindingState(live, sessionId, pid);
        if (binding === 'active') return 'still_alive';
        // Base unknown so an argv orphan reap returning stopped is distinguishable
        // from "no orphans" (which would otherwise echo a stopped base).
        const orphan = await finishWithOrphanSweep('unknown');
        if (orphan === 'still_alive') return 'still_alive';
        if (orphan === 'stopped') return 'stopped';
        const decision = decideKeepWrapperArchive(binding);
        if (decision === 'stopped') {
          logger.debug(
            `[RUNNER RUN] Detached shared root ${sessionId}; inactive registry binding confirms stop; PID ${pid} kept`
          );
        } else {
          logger.debug(
            `[RUNNER RUN] Detached shared root ${sessionId} from PID ${pid}; stop unconfirmed without registry evidence`
          );
        }
        return decision;
      };

      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (!session.sharedSessions?.[sessionId]) continue;
        if (detachSharedRootFromWrapper(session, sessionId).kind === 'keep_wrapper') {
          return await finishKeepWrapperDetach(pid);
        }
        // In-memory map had only this root (typical after restart adoption of a
        // newly reported root). Registry may still list older active siblings.
        if (await registrySiblingsKeepPid(pid) !== false) {
          return await finishKeepWrapperDetach(pid);
        }
        // Last shared entry removed — fall through so the wrapper can be stopped.
        break;
      }

      // Try to find by sessionId first (never match raw PID- here — handled above).
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          session.requestedHappySessionId === sessionId) {

          // Primary match, but live shared siblings still use this wrapper
          // (KillSession may already have cleared this id from sharedSessions).
          if (keepWrapperForSharedSiblings(session, sessionId)) {
            return await finishKeepWrapperDetach(pid);
          }

          // Post-restart: TrackedSession may only list the newly reported root
          // while older roots remain active in the durable registry on this PID.
          // Archiving the new root must not tree-kill those siblings.
          if (await registrySiblingsKeepPid(pid) !== false) {
            detachSharedRootFromWrapper(session, sessionId);
            return await finishKeepWrapperDetach(pid);
          }

          if (session.startedBy === 'runner') {
            // Adopted post-restart sessions have no ChildProcess handle — still
            // tree-kill so agent grandchildren cannot outlive the wrapper.
            // Require a persisted start marker; without it (or on mismatch), do
            // not kill by tracked PID — fall through to argv discovery.
            if (!session.childProcess) {
              const persisted = persistedResumeProcesses.get(pid);
              if (!persisted?.processStartMarker) {
                logger.debug(
                  `[RUNNER RUN] Adopted PID ${pid} has no start marker; refusing tracked kill for ${sessionId}`
                );
                const orphan = await finishWithOrphanSweep('unknown');
                if (orphan === 'still_alive') return 'still_alive';
                if (orphan === 'stopped') return 'stopped';
                return 'unknown';
              }
              const currentMarker = getProcessStartMarker(pid);
              if (currentMarker === null || currentMarker !== persisted.processStartMarker) {
                logger.debug(
                  `[RUNNER RUN] Adopted PID ${pid} generation mismatch; dropping stale tracking for ${sessionId}`
                );
                pidToTrackedSession.delete(pid);
                pidToRequestedSessionId.delete(pid);
                pidToConfirmedSessionId.delete(pid);
                if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
                releaseRecoveredSpawnDedupe(pid, existingSessionIdByChildPid, spawnSession);
                continue;
              }
            }
            try {
              const treeStopped = session.childProcess
                ? await killProcessByChildProcess(session.childProcess)
                : await killProcessTreeByPid(pid);
              if (!treeStopped) {
                logger.debug(`[RUNNER RUN] Process tree for session ${sessionId} is still alive after stop request`);
                return 'still_alive';
              }
              logger.debug(`[RUNNER RUN] Requested termination for runner-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[RUNNER RUN] Failed to kill session ${sessionId}:`, error);
              return 'still_alive';
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              if (!(await killProcess(pid))) return 'still_alive';
              logger.debug(`[RUNNER RUN] Requested termination for external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[RUNNER RUN] Failed to kill external session PID ${pid}:`, error);
              return 'still_alive';
            }
          }

          // A stop request starts termination but does not prove that a detached
          // child is gone. Keep its HAPI-row dedupe key until exit/stale detection.
          const existingSessionId = existingSessionIdByChildPid.get(pid);
          if (existingSessionId) {
            spawnSession.markChildStopping(existingSessionId);
          }
          const deadline = Date.now() + 5_000;
          while (isProcessAlive(pid) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (isProcessAlive(pid)) {
            logger.debug(`[RUNNER RUN] Session ${sessionId} process ${pid} is still alive after stop request`);
            return 'still_alive';
          }
          if (session.happySessionId) rememberVerifiedExit(session.happySessionId);
          if (session.requestedHappySessionId) rememberVerifiedExit(session.requestedHappySessionId);
          rememberVerifiedExit(`PID-${pid}`);
          pidToTrackedSession.delete(pid);
          pidToRequestedSessionId.delete(pid);
          pidToConfirmedSessionId.delete(pid);
          if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
          logger.debug(`[RUNNER RUN] Removed terminated session ${sessionId} from tracking`);
          return await finishWithOrphanSweep('stopped');
        }
      }

      // Webhook timeout can remove the normal TrackedSession before the process
      // actually exits. Retain the requested HAPI ID -> PID relation so Hub can
      // still terminate that exact generation by HAPI ID.
      const fallbackPids = new Set([
        ...pidToRequestedSessionId.keys(),
        ...pidToConfirmedSessionId.keys(),
        ...persistedResumeProcesses.keys(),
      ]);
      for (const pid of fallbackPids) {
        const persisted = persistedResumeProcesses.get(pid);
        const requestedSessionId = pidToRequestedSessionId.get(pid) ?? persisted?.requestedSessionId;
        const confirmedSessionId = pidToConfirmedSessionId.get(pid) ?? persisted?.confirmedSessionId;
        if (requestedSessionId !== sessionId && confirmedSessionId !== sessionId) continue;
        if (isProcessAlive(pid)) {
          if (!persisted) return 'still_alive';
          const currentMarker = getProcessStartMarker(pid);
          if (currentMarker === null) return 'still_alive';
          if (currentMarker !== persisted.processStartMarker) {
            // PID reuse: drop the stale mapping, but do NOT claim already_gone
            // or write a verified-exit tombstone — the HAPI CLI for this session
            // may still be alive under a different PID (#1910). Continue so
            // other fallback PIDs / argv orphan scan can still reap it.
            persistedResumeProcesses.delete(pid);
            persistResumeProcesses();
            pidToRequestedSessionId.delete(pid);
            pidToConfirmedSessionId.delete(pid);
            releaseRecoveredSpawnDedupe(pid, existingSessionIdByChildPid, spawnSession);
            continue;
          }
          const liveForPid = await liveRegistryRuntimes();
          if (liveForPid === null) return 'still_alive';
          if (wrapperHasActiveSiblingRoots(liveForPid, sessionId, pid)) {
            // Keep this shared wrapper; siblings alone are not stop proof for
            // this root — require an inactive registry binding (KillSession ack).
            const binding = sessionRegistryBindingState(liveForPid, sessionId, pid);
            if (binding === 'active') return 'still_alive';
            const orphan = await finishWithOrphanSweep('unknown');
            if (orphan === 'still_alive') return 'still_alive';
            if (orphan === 'stopped') return 'stopped';
            const decision = decideKeepWrapperArchive(binding);
            logger.debug(
              `[RUNNER RUN] Persisted PID ${pid} hosts active shared siblings for ${sessionId}; archive=${decision}`
            );
            return decision;
          }
          if (!(await killProcessTreeByPid(pid))) return 'still_alive';
          if (requestedSessionId) rememberVerifiedExit(requestedSessionId);
          if (confirmedSessionId) rememberVerifiedExit(confirmedSessionId);
          rememberVerifiedExit(`PID-${pid}`);
          pidToRequestedSessionId.delete(pid);
          pidToConfirmedSessionId.delete(pid);
          if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
          releaseRecoveredSpawnDedupe(pid, existingSessionIdByChildPid, spawnSession);
          return await finishWithOrphanSweep('stopped');
        }
        if (requestedSessionId) rememberVerifiedExit(requestedSessionId);
        if (confirmedSessionId) rememberVerifiedExit(confirmedSessionId);
        rememberVerifiedExit(`PID-${pid}`);
        pidToRequestedSessionId.delete(pid);
        pidToConfirmedSessionId.delete(pid);
        if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
        releaseRecoveredSpawnDedupe(pid, existingSessionIdByChildPid, spawnSession);
        return await finishWithOrphanSweep('already_gone');
      }

      // Maps missed (or marker-mismatch cleared a stale row). Scan live argv for
      // `--started-by runner` + this HAPI session id and tree-kill matches —
      // excluding PIDs that still host active shared sibling roots (registry
      // and/or in-memory tracked wrappers).
      {
        const liveRuntimes = await readLiveRuntimesForStop();
        if (liveRuntimes === null) return 'still_alive';
        const protectedTrackedPids = trackedSharedWrapperPidsWithSiblings(
          pidToTrackedSession.entries(),
          sessionId
        );
        const orphanStatus = await reapRunnerSpawnedOrphans(sessionId, {
          findTargets: (id) => findStopSessionOrphanTargets(
            id,
            (sid, pid) => shouldSkipOrphanPid(liveRuntimes, protectedTrackedPids, sid, pid)
          ),
        });
        if (orphanStatus === 'still_alive') {
          logger.debug(`[RUNNER RUN] Orphan argv reap still_alive for session ${sessionId} (scan_failed or kill left live PIDs)`);
          return 'still_alive';
        }
        if (orphanStatus === 'stopped') {
          rememberVerifiedExit(sessionId);
          logger.debug(`[RUNNER RUN] Reaped argv-orphan PID(s) for session ${sessionId}`);
          return 'stopped';
        }
        // No killable orphans: siblings may protect the wrapper, but that is
        // not proof this root ended. Only an inactive registry binding (Codex
        // KillSession ack) may claim stopped; otherwise stay unknown on retry.
        if (sessionRuntimeHasActiveSiblings(liveRuntimes, sessionId) || protectedTrackedPids.size > 0) {
          const binding = sessionRegistryBindingState(liveRuntimes, sessionId);
          const decision = decideKeepWrapperArchive(binding);
          logger.debug(
            `[RUNNER RUN] Session ${sessionId}; shared siblings remain; archive=${decision}`
          );
          return decision === 'still_alive' ? 'still_alive' : decision;
        }
      }

      if (hasVerifiedExit(sessionId)) {
        logger.debug(`[RUNNER RUN] Session ${sessionId} was previously observed exited`);
        return 'already_gone';
      }

      // PID- targets are handled before tracked/persisted matches above so a
      // reused OS pid cannot be tree-killed via happySessionId coincidence.

      // No PID matched and no verified-exit tombstone — distinct from
      // still_alive so callers reconciling stale rows are not blocked forever,
      // while callers that just spawned this id can treat unknown defensively.
      logger.debug(`[RUNNER RUN] Session ${sessionId} not found without verified exit`);
      return 'unknown';
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      for (const id of Object.keys(session?.sharedSessions ?? {})) rememberVerifiedExit(id);
      const requestedSessionId = session?.requestedHappySessionId ?? pidToRequestedSessionId.get(pid);
      if (requestedSessionId) rememberVerifiedExit(requestedSessionId);
      const confirmedSessionId = session?.happySessionId ?? pidToConfirmedSessionId.get(pid);
      if (confirmedSessionId) rememberVerifiedExit(confirmedSessionId);
      rememberVerifiedExit(`PID-${pid}`);
      logger.debug(`[RUNNER RUN] Removing exited process PID ${pid} from tracking`);
      const existingSessionId = existingSessionIdByChildPid.get(pid);
      if (existingSessionId) {
        spawnSession.onChildExited(existingSessionId);
        existingSessionIdByChildPid.delete(pid);
      }
      pidToTrackedSession.delete(pid);
      pidToAwaiter.delete(pid);
      pidToErrorAwaiter.delete(pid);
      pidToRequestedSessionId.delete(pid);
      pidToConfirmedSessionId.delete(pid);
      webhookTimeoutOrphanPids.delete(pid);
      if (persistedResumeProcesses.delete(pid)) persistResumeProcesses();
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startRunnerControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('hapi-cli'),
      onHappySessionWebhook
    });

    // Baseline mtime at runner-process start. Immutable: per Codex review #814
    // [Major], we must NOT refresh this on a failed handoff because the
    // heartbeat writes it into runner.state.json, and downstream
    // isRunnerRunningCurrentlyInstalledHappyVersion() compares the stored
    // value against the live installed mtime - if they match, the live
    // (still-stale) runner is reported as current. Throttle handoff attempts
    // via nextHandoffAttemptAt below instead of mutating this baseline.
    const startedWithCliMtimeMs = getInstalledCliMtimeMs();
    // Snapshot original CLI argv via the project's canonical normalizer so the
    // heartbeat's self-restart handoff can rebuild the same `runner start-sync
    // --workspace-root ...` invocation instead of losing flags.
    //
    // Codex review #814 [Major]: previously `process.argv.slice(2)` was used,
    // but in compiled binary mode (`bun build --compile`) the raw argv shape is
    // `[hapi, runner, start-sync, ...]` so slice(2) produced `['start-sync', ...]`.
    // The replacement then spawned `hapi start-sync ...`, which `resolveCommand`
    // now rejects as an unknown top-level command (previously it fell back to
    // Claude). `getCliArgs()` strips runtime + entrypoint
    // correctly in all execution modes.
    //
    // Defensive guard: only replay the captured argv when it actually starts
    // with `runner`. If the normalizer ever returns something else (unexpected
    // shape, future refactor), fall back to the safe default so the handoff
    // can never resolve to a non-runner command.
    const rawStartedWithArgv = getCliArgs();
    const startedWithArgv = rawStartedWithArgv[0] === 'runner'
      ? rawStartedWithArgv
      : ['runner', 'start-sync'];
    // Snapshot at start: did this runner opt out of version handoff via env?
    // Persisted to runner.state.json so a later `hapi runner start` from a
    // shell where the env var is NOT set can still honour the opt-out
    // (Codex review #814 [Major] - controlClient.ts:192 fix).
    const startedWithVersionHandoffDisabled = process.env.HAPI_DISABLE_VERSION_HANDOFF === '1';

    // Write initial runner state (no lock needed for state file)
    const fileState: RunnerLocallyPersistedState = {
      sharedCodexRuntime: true,
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
      startedWithApiUrl: configuration.apiUrl,
      startedWithMachineId: machineId,
      startedWithCliApiTokenHash: hashRunnerCliApiToken(configuration.cliApiToken),
      startedWithExtraHeadersHash: hashRunnerExtraHeaders(configuration.extraHeaders),
      startedWithArgv,
      startedWithVersionHandoffDisabled,
      runnerLogPath: logger.logFilePath
    };
    writeRunnerState(fileState);
    logger.debug('[RUNNER RUN] Runner state written');

    // Prepare initial runner state
    const initialRunnerState: RunnerState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      capabilities: { ...RUNNER_CAPABILITIES }
    };

    // Create API client
    const api = await ApiClient.create();

    const workspaceRoots = resolveWorkspaceRoots(options.workspaceRoots);
    logger.debug(`[RUNNER RUN] Workspace roots: ${workspaceRoots?.join(', ') ?? '(not set)'}`);

    // Get or create machine (with retry for transient connection errors)
    const machine = await withRetry(
      () => api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata({
            workspaceRoots,
            startedCliMtimeMs: startedWithCliMtimeMs,
            asRunner: true,
        }),
        runnerState: initialRunnerState
      }),
      {
        maxAttempts: 60,
        minDelay: 1000,
        maxDelay: 30000,
        shouldRetry: isRetryableConnectionError,
        onRetry: (error, attempt, nextDelayMs) => {
          const errorMsg = error instanceof Error ? error.message : String(error)
          logger.debug(`[RUNNER RUN] Failed to register machine (attempt ${attempt}), retrying in ${nextDelayMs}ms: ${errorMsg}`)
        }
      }
    );
    logger.debug(`[RUNNER RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine, { workspaceRoots });

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('hapi-app')
    });

    // Connect to server
    apiMachine.connect();
    scheduleCursorModelsPrewarm();

    // Visible startup banner. Use console.log so it always appears on stdout,
    // regardless of the verbose/quiet logger setting.
    console.log('');
    console.log('Hapi runner started.');
    console.log(`  Workspace roots: ${workspaceRoots?.join(', ') ?? '(not set — browsing and spawning are unrestricted)'}`);
    console.log(`  Hub URL:        ${configuration.apiUrl}`);
    console.log(`  Machine ID:     ${machine.id}`);
    console.log(`  Control port:   ${controlPort}`);
    console.log('Waiting for sessions. Press Ctrl+C to stop.');
    console.log('');

    reportSpawnOutcomeToHub = (outcome) => {
      void apiMachine.updateRunnerState((state: RunnerState | null) => {
        const baseState: RunnerState = state
          ? { ...state }
          : { status: 'running' };

        if (typeof baseState.pid !== 'number') {
          baseState.pid = process.pid;
        }
        if (typeof baseState.httpPort !== 'number') {
          baseState.httpPort = controlPort;
        }
        if (typeof baseState.startedAt !== 'number') {
          baseState.startedAt = Date.now();
        }

        if (outcome.type === 'success') {
          return {
            ...baseState,
            lastSpawnError: null
          };
        }

        return {
          ...baseState,
          lastSpawnError: {
            message: outcome.details.message,
            pid: outcome.details.pid,
            exitCode: outcome.details.exitCode ?? null,
            signal: outcome.details.signal ?? null,
            at: Date.now()
          }
        };
      }).catch((error) => {
        logger.debug('[RUNNER RUN] Failed to update runner state with spawn outcome', error);
      });
    };

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if runner needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    // Timestamp (ms) gate for handoff retries after a failed spawn or timed-out
    // handoff. Per Codex review #814 [Major], we previously mutated
    // startedWithCliMtimeMs to throttle re-attempts, but that polluted
    // runner.state.json (the heartbeat persists this value) and caused
    // isRunnerRunningCurrentlyInstalledHappyVersion() to lie about the live
    // runner being current. The honest fix: leave startedWithCliMtimeMs
    // immutable, gate handoff entry on this timestamp, and refresh it from
    // the failure path with a backoff window.
    let nextHandoffAttemptAt = 0;
    const HANDOFF_RETRY_BACKOFF_MS = 5 * 60_000;
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[RUNNER RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      const pidsToCheck = new Set([
        ...pidToTrackedSession.keys(),
        ...existingSessionIdByChildPid.keys()
      ]);
      for (const pid of pidsToCheck) {
        if (!isProcessAlive(pid)) {
          logger.debug(`[RUNNER RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          onChildExited(pid);
          continue;
        }
        const persisted = persistedResumeProcesses.get(pid);
        if (persisted) {
          const generation = classifyRecoveredProcessGeneration(
            true,
            getProcessStartMarker(pid),
            persisted.processStartMarker
          );
          if (generation === 'exited') {
            logger.debug(`[RUNNER RUN] Removing stale session with reused PID ${pid}`);
            onChildExited(pid);
          } else if (generation === 'verified' && pidToRequestedSessionId.get(pid) !== persisted.requestedSessionId) {
            pidToRequestedSessionId.set(pid, persisted.requestedSessionId);
            if (persisted.confirmedSessionId) pidToConfirmedSessionId.set(pid, persisted.confirmedSessionId);
            spawnSession.recoverChild(
              persisted.requestedSessionId,
              persisted.confirmedSessionId
                ? { type: 'success', sessionId: persisted.confirmedSessionId }
                : { type: 'error', errorMessage: `Session ${persisted.requestedSessionId} is still starting` }
            );
          }
        }
      }

      // Check if runner needs update.
      // Skip entirely when the operator owns process supervision (systemd, tmux,
      // custom rebuild pipelines, etc.) and source mtimes change for reasons
      // unrelated to an actual npm upgrade. HAPI_DISABLE_VERSION_HANDOFF=1
      // keeps the rest of the heartbeat (session pruning, state file
      // persistence) intact.
      if (process.env.HAPI_DISABLE_VERSION_HANDOFF === '1') {
        if (process.env.DEBUG) {
          logger.debug('[RUNNER RUN] HAPI_DISABLE_VERSION_HANDOFF=1 set, skipping mtime/version drift self-restart');
        }
      } else {
        const installedCliMtimeMs = getInstalledCliMtimeMs();
        if (typeof installedCliMtimeMs === 'number' &&
            typeof startedWithCliMtimeMs === 'number' &&
            installedCliMtimeMs !== startedWithCliMtimeMs &&
            Date.now() >= nextHandoffAttemptAt) {
          logger.debug('[RUNNER RUN] Runner is outdated, triggering self-restart with latest version');

          // Hand off to a fresh runner that inherits our original argv (workspace
          // roots, flags, etc). Previously this called `runner start` with no
          // args, which forwarded an arg-less `runner start-sync` and lost the
          // operator's --workspace-root configuration. Worse, the old code
          // cleared the heartbeat interval and process.exit(0)'d unconditionally,
          // so any failure in the replacement left the machine offline with no
          // runner at all (especially under systemd Restart=on-failure, which
          // does not restart on clean exits).
          //
          // New behaviour:
          // 1. Replay the original argv (default: ['runner','start-sync']) so the
          //    new process boots with the same workspace roots / flags.
          // 2. Wait for runner.state.json to show a different live PID, proving
          //    the replacement actually came up.
          // 3. Only clear the heartbeat + exit when handoff is confirmed; if it
          //    fails, stay alive so the machine stays online. heartbeatRunning
          //    re-entry guard prevents this block from running concurrently if
          //    the next heartbeat fires while we are still waiting.
          //
          // startedWithArgv is guaranteed by the normalizer + defensive guard
          // above to start with `runner`, so we replay it directly.
          const handoffArgv = startedWithArgv;

          // On any failure path: reschedule the next handoff attempt for
          // HANDOFF_RETRY_BACKOFF_MS into the future. We deliberately do NOT
          // touch startedWithCliMtimeMs - the heartbeat must continue to
          // persist the honest "still on the old code" value into
          // runner.state.json so external tooling (and the controlClient
          // mtime check) can see the runner is stale. Codex review #814
          // [Major].
          const deferHandoffRetry = () => {
            nextHandoffAttemptAt = Date.now() + HANDOFF_RETRY_BACKOFF_MS;
            heartbeatRunning = false;
          };

          // Spawn the replacement with HAPI_RUNNER_HANDOFF_FROM_PID set so
          // the child knows it is an authorized handoff and must NOT call
          // stopRunner() against us before writing its own state.
          // Codex review #814 [Major] on run.ts:892.
          try {
            spawnHappyCLI(handoffArgv, {
              detached: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                HAPI_RUNNER_HANDOFF_FROM_PID: String(process.pid)
              }
            });
          } catch (error) {
            logger.debug(`[RUNNER RUN] Failed to spawn replacement runner; staying alive to avoid an offline machine. Next handoff attempt in ${Math.round(HANDOFF_RETRY_BACKOFF_MS / 1000)}s.`, error);
            deferHandoffRetry();
            return;
          }

          // Release the lock so the child can acquire it. The child is
          // configured (above, in its startRunner() entry) with a longer
          // lock-retry window when HAPI_RUNNER_HANDOFF_FROM_PID is set, so
          // it will wait through this release. We deliberately release
          // BEFORE waitForRunnerHandoff to break the original deadlock:
          // child cannot write state (and thus cannot signal handoff
          // success) until it holds the lock, and the lock is ours until
          // we release.
          try {
            await releaseRunnerLock(runnerLockHandle);
          } catch (error) {
            logger.debug('[RUNNER RUN] Failed to release lock for child handoff; continuing wait anyway', error);
          }

          logger.debug(`[RUNNER RUN] Spawned replacement runner with argv: ${JSON.stringify(handoffArgv)}; released lock; waiting for handoff`);

          const handoffOk = await waitForRunnerHandoff(process.pid, { timeoutMs: 30_000 });
          if (!handoffOk) {
            logger.debug(`[RUNNER RUN] Replacement runner did not register within 30s; attempting to re-acquire lock and stay alive to avoid leaving the machine offline.`);
            // Re-acquire the lock with a long window (the child has likely
            // either succeeded and we're seeing a stale state, or it gave
            // up - in either case the lock should be available shortly).
            const reacquired = await acquireRunnerLock(60, 500);
            if (!reacquired) {
              // Lock is held by someone else (third-party runner, or a
              // child that succeeded but state file hasn't reflected the
              // new pid yet). Cleanest action: exit, log clearly. The
              // operator will see an offline machine if the holder also
              // dies, but staying alive without the lock invariant is
              // worse - it lets a parallel runner register against the
              // same machine id.
              logger.debug('[RUNNER RUN] Could not re-acquire runner lock after failed handoff; another process holds it. Exiting cleanly.');
              clearInterval(restartOnStaleVersionAndHeartbeat);
              process.exit(0);
              return;
            }
            runnerLockHandle = reacquired;
            deferHandoffRetry();
            return;
          }

          logger.debug('[RUNNER RUN] Handoff confirmed; clearing heartbeat and exiting cleanly');
          clearInterval(restartOnStaleVersionAndHeartbeat);
          process.exit(0);
        }
      }

      // Before wrecklessly overriting the runner state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const runnerState = await readRunnerState();
      if (runnerState && runnerState.pid !== process.pid) {
        logger.debug('[RUNNER RUN] Somehow a different runner was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different runner was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: RunnerLocallyPersistedState = {
          ...fileState,
          lastHeartbeat: new Date().toLocaleString()
        };
        writeRunnerState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[RUNNER RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[RUNNER RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[RUNNER RUN] Health check interval cleared');
      }

      // Update runner state before shutting down
      await apiMachine.updateRunnerState((state: RunnerState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupRunnerState();
      await releaseRunnerLock(runnerLockHandle);

      logger.debug('[RUNNER RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[RUNNER RUN] Runner started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[RUNNER RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}

export function buildCliArgs(
  agent: string,
  options: SpawnSessionOptions,
  yolo?: boolean
): string[] {
  if (agent === 'gemini') {
    throw new Error('Gemini CLI is no longer supported and cannot be launched (Google sunset the consumer Gemini CLI on 2026-06-18).');
  }
  const agentCommand = agent === 'codex'
    ? 'codex'
    : agent === 'cursor'
      ? 'cursor'
      : agent === 'grok'
        ? 'grok'
        : agent === 'kimi'
          ? 'kimi'
          : agent === 'copilot'
            ? 'copilot'
            : agent === 'opencode'
            ? 'opencode'
            : agent === 'dsh'
              ? 'dsh'
              : agent === 'pi'
                ? 'pi'
                : agent === 'agy'
                  ? 'agy'
                  : 'claude';
  const args = [agentCommand];
  if (options.resumeSessionId) {
    if (agent === 'codex') {
      args.push('resume', options.resumeSessionId);
    } else if (agent === 'cursor') {
      args.push('--resume', options.resumeSessionId);
    } else if (agent === 'pi') {
      // Pi uses --session-id for exact session resume (RPC mode)
      args.push('--session-id', options.resumeSessionId);
    } else {
      args.push('--resume', options.resumeSessionId);
    }
  }
  // agy headless reuses the existing hub row on reopen/resume via the generic
  // --existing-session-id flow (no PTY special case anymore).
  // Message-level Fork current for Claude: must follow --resume.
  if (options.forkSession && agentCommand === 'claude') {
    args.push('--fork-session');
  }
  const startingMode = options.startingMode || 'remote';
  // Codex shares one engine; Runner owns the wrapper, not a remote mode.
  if (agent !== 'codex') args.push('--hapi-starting-mode', startingMode);
  args.push('--started-by', 'runner');
  // Stamp the HAPI row id on argv for orphan reap after tracking loss (#1910).
  // Adopt-stub (`--hapi-session-id`) vs reopen (`--existing-session-id`) are
  // different operations — never collapse them (#1911 Opus Critical + Codex Major).
  // Local HTTP non-UUID sessionId stays on --hapi-session-id (reap-only; create
  // ignores non-UUID reserved ids). A UUID sessionId must NOT stamp adopt — that
  // would 404/409 against a non-stub row (#1911 Opus Major @ 09141964c).
  const hubUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (options.existingSessionId) {
    args.push('--existing-session-id', options.existingSessionId);
  } else if (options.reservedSessionId) {
    args.push('--hapi-session-id', options.reservedSessionId);
  } else if (options.sessionId && !hubUuid.test(options.sessionId)) {
    args.push('--hapi-session-id', options.sessionId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort && (agent === 'claude' || agent === 'grok' || agent === 'pi' || agent === 'agy')) {
    args.push('--effort', options.effort);
  }
  if (options.modelReasoningEffort && (agent === 'codex' || agent === 'opencode')) {
    args.push('--model-reasoning-effort', options.modelReasoningEffort);
  }
  if (options.serviceTier && agent === 'codex') {
    args.push('--service-tier', options.serviceTier);
  }
  if (options.collaborationMode && options.collaborationMode !== 'default' && agent === 'codex') {
    args.push('--collaboration-mode', options.collaborationMode);
  }
  if (options.copilotAgentMode && options.copilotAgentMode !== 'interactive' && agent === 'copilot') {
    args.push('--copilot-agent-mode', options.copilotAgentMode);
  }
  // Pi RPC mode has no permission switching; never pass these flags to it
  // (the Pi parser rejects --permission-mode and ignores --yolo).
  if (agent !== 'pi' && agent !== 'dsh') {
    if (options.permissionMode && (PERMISSION_MODES as readonly string[]).includes(options.permissionMode)) {
      args.push('--permission-mode', options.permissionMode);
    } else if (yolo) {
      args.push('--yolo');
    }
  }
  if (agent === 'cursor' && options.sessionType === 'worktree') {
    // Nested Cursor --worktree inside an existing linked git worktree hangs ACP
    // initialize (banner ignored, but never reaches protocolVersion / cursorSessionId).
    if (!isLinkedGitWorktree(options.directory)) {
      args.push('--cursor-worktree');
      const name = options.worktreeName?.trim();
      if (name) {
        args.push(name);
      }
    }
  }
  return args;
}
