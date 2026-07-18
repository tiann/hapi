import fs from 'fs/promises';
import os from 'os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { RunnerState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult, type QuerySpawnSessionResult } from '@/modules/common/rpcTypes';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeRunnerState, RunnerLocallyPersistedState, readRunnerState, acquireRunnerLock, releaseRunnerLock } from '@/persistence';
import { isProcessAlive, isWindows, killProcessByChildProcess } from '@/utils/process';
import { PERMISSION_MODES } from '@hapi/protocol/modes';
import { withRetry } from '@/utils/time';
import { isRetryableConnectionError } from '@/utils/errorUtils';

import { cleanupRunnerState, getInstalledCliMtimeMs, isRunnerRunningCurrentlyInstalledHappyVersion, stopRunner } from './controlClient';
import { startRunnerControlServer } from './controlServer';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktree';
import { join } from 'path';
import { buildMachineMetadata } from '@/agent/sessionFactory';
import { hashRunnerCliApiToken } from './runnerIdentity';
import { PrivacyPreflight, SpawnAdmissionController, readRunnerReconcileConfig, type SpawnAdmission } from './privacyPreflight';
import { startVerifiedRunnerOwnership, type VerifiedRunnerOwnership } from './runnerOwnershipRuntime';
import { ManagedLaunchJournal, type PreparedManagedLaunch } from './managedLaunchJournal';
import { RUNNER_TIMING } from './runnerConstants';
import {
  createProcessEvidenceSweep,
  findManagedProcessEvidence,
  readProcessIdentity,
  readProcessGroupEvidence,
  isCompleteOwnedProcessGroup
} from './processIdentity';
import { reconcileLaunches } from './reconciliation';
import {
  ManagedOutcomeMailbox,
  ingestManagedOutcomeSpools,
  type SignedManagedOutcome
} from './managedOutcomeMailbox';
import { queryRunnerLock, startRunnerLockHelper, type RunnerLockHandle } from './lockHelper';
import { proveRecordedProcessGroupEmpty } from './startupAbsence';
import { waitForForegroundReplacementReady } from './foregroundReplacement';
import { createResumeProfileFingerprint } from './resumeProfile';
import {
  isManagedSpawnAdmissionReady,
  verifyRunnerLaunchAgentIdentity
} from './supportedTopology';
import {
  SpawnRequestStore,
  fingerprintLegacySpawnSessionOptions,
  fingerprintSpawnSessionOptions,
  querySpawnRequest,
  recoverCommittedSpawnResult
} from './spawnRequestStore';
import {
  isAdmittedLaunchProvenAbsent,
  reconcileAdmittedLaunchAbsence,
  reconcileNonDestructiveLaunchAbsence,
  reconcileStoppedLaunchProofs,
  resolvePersistedPendingSpawn,
  restorePendingLaunchBindings,
  settleCanonicalManagedWebhook,
  settleProvenEmptyLaunchRequests,
  settleSpawnRequestAfterExit
} from './spawnRequestReconciliation';
import { hasProvenEmptyProcessGroup, type LaunchRecord } from './ownershipJournal';
import { createRunnerReconciliationKillSwitchReader } from './reconciliationSafety';
import {
  classifyUntrackedManagedWebhook,
  hasManagedWebhookIdentity,
  isValidManagedWebhookHostPid,
  mustRetryManagedWebhook,
  type ManagedLaunchIdentity
} from './managedWebhookRouting';
import {
  CLAUDE_API_AGENT,
  CLAUDE_ARK_AGENT,
  CLAUDE_DEEPSEEK_AGENT,
  HERMES_MOA_AGENT,
  ensureManagedCodexHome,
  getRunnerAgentEnv,
  getRunnerBaseEnv,
  getSanitizedRunnerChildEnv,
  getUserHome,
  isClaudeApiAgent,
  isClaudeArkAgent,
  isClaudeDeepSeekAgent,
  isClaudeFamilyAgent,
  isHermesMoaAgent
} from './providerRuntime';
import { ProviderReadinessService } from './providerReadiness';
import {
  resolveEffectiveRunnerEffort,
  resolveEffectiveRunnerModel,
  resolveEffectiveRunnerPermissionMode,
  resolveEffectiveRunnerServiceTier,
  resolveRunnerReadinessModel
} from './providerSelection';
import {
  connectAndPublishProviderReadiness,
  createProviderReadinessPublisher,
  runWithProviderSpawnReadiness,
  type ProviderReadinessPublisher
} from './providerReadinessRuntime';

function readIntegrationSessionStartedFailureCount(env: NodeJS.ProcessEnv): number {
  if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') return 0;
  const raw = env.HAPI_RUNNER_INTEGRATION_SESSION_STARTED_FAILURES?.trim();
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new Error('HAPI_RUNNER_INTEGRATION_SESSION_STARTED_FAILURES must be an integer between 0 and 10');
  }
  return count;
}

function readIntegrationSessionStartedAckLossCount(env: NodeJS.ProcessEnv): number {
  if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') return 0;
  const raw = env.HAPI_RUNNER_INTEGRATION_SESSION_STARTED_ACK_LOSSES?.trim();
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new Error('HAPI_RUNNER_INTEGRATION_SESSION_STARTED_ACK_LOSSES must be an integer between 0 and 10');
  }
  return count;
}

function readIntegrationManagedCommitDelayMs(env: NodeJS.ProcessEnv): number {
  if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') return 0;
  const raw = env.HAPI_RUNNER_INTEGRATION_MANAGED_COMMIT_DELAY_MS?.trim();
  if (!raw) return 0;
  const delay = Number(raw);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30_000) {
    throw new Error('HAPI_RUNNER_INTEGRATION_MANAGED_COMMIT_DELAY_MS must be an integer between 0 and 30000');
  }
  return delay;
}

function readIntegrationAttachPidFailureCount(env: NodeJS.ProcessEnv): number {
  if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') return 0;
  const raw = env.HAPI_RUNNER_INTEGRATION_ATTACH_PID_FAILURES?.trim();
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new Error('HAPI_RUNNER_INTEGRATION_ATTACH_PID_FAILURES must be an integer between 0 and 10');
  }
  return count;
}

function readIntegrationCommitIdentityFailureCount(env: NodeJS.ProcessEnv): number {
  if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') return 0;
  const raw = env.HAPI_RUNNER_INTEGRATION_COMMIT_IDENTITY_FAILURES?.trim();
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new Error('HAPI_RUNNER_INTEGRATION_COMMIT_IDENTITY_FAILURES must be an integer between 0 and 10');
  }
  return count;
}

export async function startRunner(): Promise<void> {
  const admissionController = new SpawnAdmissionController();
  const runnerInstanceId = randomUUID();
  type ShutdownSource = 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception' | 'replacement';
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let shutdownWatchdog: ReturnType<typeof setTimeout> | null = null;
  let shutdownRequested = false;
  let requestedShutdownExitCode = 1;
  let providerReadiness: ProviderReadinessService | null = null;
  let requestShutdown: (source: ShutdownSource, errorMessage?: string, exitCode?: number) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: ShutdownSource, errorMessage?: string, exitCode: number })>((resolve) => {
    requestShutdown = (source, errorMessage, exitCode = source === 'exception' ? 1 : 0) => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      requestedShutdownExitCode = exitCode;
      logger.debug(`[RUNNER RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);
      // Stop accepting and abort in-flight preparation immediately. Cleanup and
      // child reaping wait for cleanupAndShutdown's verified ownership result.
      void admissionController.beginDrain();
      void providerReadiness?.shutdown();

      // Bound graceful cleanup below the supported launchd ExitTimeOut.
      shutdownWatchdog = setTimeout(async () => {
        logger.debug(`[RUNNER RUN] Graceful shutdown deadline exceeded, forcing exit with code ${exitCode || 1}`);

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(exitCode || 1);
      }, RUNNER_TIMING.watchdogMs);
      shutdownWatchdog.unref();

      // Start graceful shutdown
      resolve({ source, errorMessage, exitCode });
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

  // Serialize old-lock migration separately. A legacy runner may unlink
  // runner.lock on exit, so the permanent flock must be acquired only after
  // that process has fully stopped.
  let verifiedOwnership: VerifiedRunnerOwnership | null = null;
  let legacyRunnerLockHandle: Awaited<ReturnType<typeof acquireRunnerLock>> = null;
  if (process.platform === 'darwin' || process.platform === 'linux') {
    let migrationGuard: RunnerLockHandle | null = null;
    try {
      migrationGuard = await startRunnerLockHelper({ lockPath: join(configuration.happyHomeDir, 'runner-migration.lock') });
      const permanent = await queryRunnerLock({ lockPath: join(configuration.happyHomeDir, 'runner.lock') });
      if (permanent.locked) {
        await migrationGuard.close();
        logger.debug('[RUNNER RUN] Verified runner lock is already held');
        process.exit(process.env.HAPI_RUNNER_SUPERVISED === 'launchd' ? 75 : 0);
      }

      const runningRunnerVersionMatches = await isRunnerRunningCurrentlyInstalledHappyVersion();
      logger.debug(runningRunnerVersionMatches
        ? '[RUNNER RUN] Existing runner predates verified ownership; stopping it before migration'
        : '[RUNNER RUN] Stopping stale or version-mismatched legacy runner before migration');
      if (!await stopRunner()) {
        await migrationGuard.close();
        throw new Error('Existing runner could not be stopped safely; refusing split-brain startup');
      }
      verifiedOwnership = await startVerifiedRunnerOwnership({ home: configuration.happyHomeDir, runnerInstanceId });
      await migrationGuard.close();
      migrationGuard = null;
    } catch (error) {
      await migrationGuard?.close().catch(() => {});
      if (error instanceof Error && /already locked/.test(error.message)) {
        logger.debug('[RUNNER RUN] Runner ownership migration is already in progress');
        process.exit(process.env.HAPI_RUNNER_SUPERVISED === 'launchd' ? 75 : 0);
      }
      throw error;
    }
  } else {
    legacyRunnerLockHandle = await acquireRunnerLock(5, 200);
    if (!legacyRunnerLockHandle) {
      logger.debug('[RUNNER RUN] Runner lock file already held, another runner is running');
      process.exit(0);
    }
  }

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    if (!await stopRunner()) {
      if (legacyRunnerLockHandle) await releaseRunnerLock(legacyRunnerLockHandle);
      throw new Error('Existing runner could not be stopped safely; refusing split-brain startup');
    }
  }

  let integrationCommitIdentityFailuresRemaining = readIntegrationCommitIdentityFailureCount(process.env);
  const managedLaunches = verifiedOwnership ? new ManagedLaunchJournal({
    journal: verifiedOwnership.journal,
    runnerInstanceId,
    runnerPid: verifiedOwnership.runnerIdentity.pid,
    runnerBirthToken: verifiedOwnership.runnerIdentity.birthToken,
    helperPid: verifiedOwnership.helper.helperPid,
    helperBirthToken: verifiedOwnership.helper.helperBirthToken,
    bootId: verifiedOwnership.bootId,
    runtimeRealpath: verifiedOwnership.runtimeRealpath,
    readIdentity: async (pid) => {
      if (integrationCommitIdentityFailuresRemaining > 0) {
        integrationCommitIdentityFailuresRemaining -= 1;
        return null;
      }
      return await readProcessIdentity(pid);
    }
  }) : null;
  const managedOutcomeMailbox = verifiedOwnership
    ? new ManagedOutcomeMailbox({ home: configuration.happyHomeDir, journal: verifiedOwnership.journal })
    : null;
  let performManagedOutcomeDrain: () => Promise<number> = async () => 0;
  let managedOutcomeDrainTail: Promise<void> = Promise.resolve();
  const flushManagedOutcomes = (): Promise<number> => {
    const run = managedOutcomeDrainTail
      .catch(() => undefined)
      .then(async () => await performManagedOutcomeDrain());
    managedOutcomeDrainTail = run.then(() => undefined, () => undefined);
    return run;
  };
  let ownershipClosing = false;
  void verifiedOwnership?.helper.whenLost.then(() => {
    if (!ownershipClosing) requestShutdown('exception', 'Runner lock helper exited unexpectedly');
  });

  // At this point we should be safe to startup the runner:
  // 1. Not have a stale runner state
  // 2. Should not have another runner process running

  try {
    const privacyPreflight = new PrivacyPreflight();
    const reconcileConfig = await readRunnerReconcileConfig(configuration.happyHomeDir);
    const launchIdentity = await verifyRunnerLaunchAgentIdentity({
      platform: process.platform,
      supervised: process.env.HAPI_RUNNER_SUPERVISED,
      parentPid: process.ppid,
      currentPid: process.pid,
      currentUid: process.getuid?.() ?? -1,
      hapiHome: configuration.happyHomeDir,
      homeDirectory: getUserHome(),
      execPath: process.execPath,
      argv: process.argv,
      workingDirectory: process.cwd()
    });
    const launchContextEligible = launchIdentity.eligible;
    if (!launchContextEligible && reconcileConfig.mode === 'enforce') {
      logger.debugLargeJson('[RUNNER RUN] LaunchAgent identity is report-only', launchIdentity);
    }
    const runtimeEntrypoint = process.argv[1]?.startsWith('/') ? process.argv[1] : process.execPath;
    const preflightResult = await privacyPreflight.probeConfiguredRoots(reconcileConfig.allowedWorkspaceRoots, runtimeEntrypoint);
    if (!preflightResult.enforceEligible) {
      logger.debugLargeJson('[RUNNER RUN] Privacy preflight is report-only', preflightResult.failures);
    }
    await admissionController.markReconciling();

    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[RUNNER RUN] Auth and machine setup complete');
    if (shutdownRequested) throw new Error('Runner shutdown was requested during startup');
    const activeProviderReadiness = new ProviderReadinessService();
    providerReadiness = activeProviderReadiness;
    const initialProviderReadiness = await activeProviderReadiness.probeAll();
    if (shutdownRequested) throw new Error('Runner shutdown was requested during provider readiness startup');
    let publishProviderReadiness: ProviderReadinessPublisher | undefined;

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const spawnRequestStore = new SpawnRequestStore({ home: configuration.happyHomeDir });

    const earlyManagedWebhooks = new Map<number, { sessionId: string; metadata: Metadata }>();
    const pendingManagedLaunches = new Map<number, ManagedLaunchIdentity>();
    let integrationSessionStartedFailuresRemaining = readIntegrationSessionStartedFailureCount(process.env);
    let integrationSessionStartedAckLossesRemaining = readIntegrationSessionStartedAckLossCount(process.env);
    const integrationManagedCommitDelayMs = readIntegrationManagedCommitDelayMs(process.env);
    let integrationAttachPidFailuresRemaining = readIntegrationAttachPidFailureCount(process.env);
    const pendingJournalWrites = new Set<Promise<unknown>>();
    const trackJournalWrite = <T>(operation: Promise<T>): Promise<T> => {
      pendingJournalWrites.add(operation);
      void operation.then(
        () => pendingJournalWrites.delete(operation),
        () => pendingJournalWrites.delete(operation)
      );
      return operation;
    };
    const markJournalProvenSpawnReclaimable = async (launchNonce: string): Promise<void> => {
      if (!verifiedOwnership) return;
      const record = (await verifiedOwnership.journal.snapshot()).launches[launchNonce];
      if (record && hasProvenEmptyProcessGroup(record)) {
        await spawnRequestStore.markSuccessesReclaimable([launchNonce]);
      }
    };
    const settleVerifiedEmptySpawnRequest = async (
      launchNonce: string,
      errorMessage: string
    ): Promise<SpawnSessionResult | null> => {
      if (!verifiedOwnership) return null;
      const launch = (await verifiedOwnership.journal.snapshot()).launches[launchNonce];
      if (!launch) return null;
      return await spawnRequestStore.settleVerifiedEmptyLaunch({
        launchNonce,
        runnerInstanceId: launch.runnerInstanceId,
        errorMessage
      });
    };
    const convergeProvenEmptyLaunchRequest = async (
      launch: LaunchRecord,
      errorMessage: string
    ): Promise<SpawnSessionResult | null> => {
      if (launch.hapiSessionId) {
        if (!launch.pid) return null;
        const result = await spawnRequestStore.completeSuccessFromWebhook({
          pid: launch.pid,
          sessionId: launch.hapiSessionId,
          launchNonce: launch.launchNonce,
          runnerInstanceId: launch.runnerInstanceId
        });
        if (result?.type === 'success') {
          await spawnRequestStore.markSuccessesReclaimable([launch.launchNonce]);
        }
        return result;
      }
      return await spawnRequestStore.settleVerifiedEmptyLaunch({
        launchNonce: launch.launchNonce,
        runnerInstanceId: launch.runnerInstanceId,
        errorMessage
      });
    };
    const recordManagedExit = async (pid: number, exitCode: number | null): Promise<boolean> => {
      if (!managedLaunches) return false;
      const launchNonce = managedLaunches.launchNonceForPid(pid);
      const processGroupProvenEmpty = await managedLaunches.recordExit(pid, exitCode);
      if (launchNonce && processGroupProvenEmpty) await markJournalProvenSpawnReclaimable(launchNonce);
      return processGroupProvenEmpty;
    };
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

    const terminateRejectedManagedSpawn = async (pid: number): Promise<boolean> => {
      if (!managedLaunches) return false;
      const waitForEmptyGroup = async (pgid: number, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const evidence = await readProcessGroupEvidence(pgid);
          if (evidence.complete && evidence.members.length === 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };
      try {
        let identity = await managedLaunches.writeSpawnRejectionIntent(pid);
        let group = await readProcessGroupEvidence(identity.pgid);
        if (group.complete && group.members.length === 0) return true;
        if (!isCompleteOwnedProcessGroup(identity, group)) return false;
        process.kill(-identity.pgid, 'SIGTERM');
        if (await waitForEmptyGroup(identity.pgid, RUNNER_TIMING.termGraceMs)) return true;
        identity = await managedLaunches.writeSpawnRejectionIntent(pid);
        group = await readProcessGroupEvidence(identity.pgid);
        if (group.complete && group.members.length === 0) return true;
        if (!isCompleteOwnedProcessGroup(identity, group)) return false;
        process.kill(-identity.pgid, 'SIGKILL');
        return await waitForEmptyGroup(identity.pgid, RUNNER_TIMING.killSettlementMs);
      } catch (error) {
        logger.debug(`[RUNNER RUN] Refusing unverified rejected-spawn termination for PID ${pid}`, error);
        return false;
      }
    };

    const terminalizeLaunchIfVerifiedAbsent = async (launch: PreparedManagedLaunch): Promise<boolean> => {
      if (!managedLaunches) return false;
      const evidence = await findManagedProcessEvidence(launch.launchNonce, launch.runnerInstanceId, 1);
      if (!evidence.complete || evidence.matches.length !== 0) return false;
      await managedLaunches.terminalizeVerifiedAbsent(launch.launchNonce);
      return true;
    };

    const acceptManagedWebhook = async (
      pid: number,
      sessionId: string,
      metadata: Metadata
    ): Promise<boolean> => {
      if (!managedLaunches) return false;
      let accepted = false;
      try {
        accepted = await settleCanonicalManagedWebhook({
          pid,
          sessionId,
          launchNonce: metadata.launchNonce,
          runnerInstanceId: metadata.runnerInstanceId,
          recordIdentity: async (input) => {
            return await managedLaunches.recordWebhookByIdentity({
              pid: input.pid,
              launchNonce: input.launchNonce,
              runnerInstanceId: input.runnerInstanceId,
              hapiSessionId: input.sessionId
            });
          },
          completeSuccess: async (input) => {
            return Boolean(await spawnRequestStore.completeSuccessFromWebhook(input));
          }
        });
      } catch (error) {
        logger.debug(`[RUNNER RUN] Failed to persist canonical managed webhook for PID ${pid}`, error);
        throw error;
      }
      if (!accepted) return false;
      await markJournalProvenSpawnReclaimable(metadata.launchNonce!).catch((error) => {
        logger.debug(`[RUNNER RUN] Failed to mark canonical managed webhook reclaimable for PID ${pid}`, error);
      });
      await flushManagedOutcomes().catch((error) => {
        logger.debug(`[RUNNER RUN] Failed to flush managed outcomes after webhook for PID ${pid}`, error);
      });
      return true;
    };

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from HAPI session reporting itself
    const onHappySessionWebhook = async (sessionId: string, sessionMetadata: Metadata): Promise<void> => {
      logger.debugLargeJson(`[RUNNER RUN] Session reported`, sessionMetadata);

      if (integrationSessionStartedFailuresRemaining > 0) {
        integrationSessionStartedFailuresRemaining -= 1;
        throw new Error('Injected integration session-started persistence failure');
      }

      const candidatePid: unknown = sessionMetadata.hostPid;
      if (!isValidManagedWebhookHostPid(candidatePid)) {
        if (hasManagedWebhookIdentity(sessionMetadata)) {
          throw new Error(`Managed session webhook for ${sessionId} has no valid hostPid`);
        }
        logger.debug(`[RUNNER RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }
      const pid = candidatePid;
      const managedWebhookAccepted = managedLaunches
        ? await acceptManagedWebhook(pid, sessionId, sessionMetadata)
        : false;
      if (managedWebhookAccepted && integrationSessionStartedAckLossesRemaining > 0) {
        integrationSessionStartedAckLossesRemaining -= 1;
        logger.debug('[RUNNER RUN] Injected integration acknowledgement loss after durable webhook settlement');
        throw new Error('Injected integration acknowledgement loss after durable webhook settlement');
      }
      logger.debug(`[RUNNER RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[RUNNER RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (runner-spawned)
      const existingSession = pidToTrackedSession.get(pid);
      const untrackedRoute = classifyUntrackedManagedWebhook({
        pendingIdentity: pendingManagedLaunches.get(pid),
        journalLaunchNonce: managedLaunches?.launchNonceForPid(pid),
        managedWebhookAccepted,
        launchNonce: sessionMetadata.launchNonce,
        runnerInstanceId: sessionMetadata.runnerInstanceId
      });

      // Exact pending identity always wins over stale PID-only tracking. Keep
      // the payload for the spawn owner and force retry until both durable
      // stores acknowledge it.
      if (untrackedRoute === 'buffer-managed') {
        earlyManagedWebhooks.set(pid, { sessionId, metadata: sessionMetadata });
        logger.debug(`[RUNNER RUN] Buffered early managed webhook for PID ${pid}`);
        if (mustRetryManagedWebhook(untrackedRoute, managedWebhookAccepted)) {
          throw new Error(`Managed session webhook for PID ${pid} is awaiting durable launch settlement`);
        }
        return;
      }

      // Managed-looking traffic is never a successful no-op. A non-2xx keeps
      // the child's exact delivery retry alive while startup adoption or
      // durable reconciliation repairs the launch binding.
      if (mustRetryManagedWebhook(untrackedRoute, managedWebhookAccepted)) {
        throw new Error(`Managed session webhook for PID ${pid} is not durably bound to this Runner`);
      }

      if (existingSession && existingSession.startedBy === 'runner' && managedWebhookAccepted) {
        // Update runner-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[RUNNER RUN] Updated runner-spawned session ${sessionId} with metadata`);
      } else if (untrackedRoute === 'accept-late-managed') {
        logger.debug(`[RUNNER RUN] Accepted late managed webhook for exited PID ${pid}`);
      } else if (!existingSession && untrackedRoute === 'register-external') {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'hapi directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[RUNNER RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSessionAfterProviderReadiness = async (
      options: SpawnSessionOptions & { spawnRequestId: string }
    ): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[RUNNER RUN] Spawning session', options);

      const { directory, sessionId, machineId, spawnRequestId, approvedNewDirectoryCreation = true } = options;
      const agent = options.agent ?? 'claude';
      const yolo = options.yolo === true;
      const sessionType = options.sessionType ?? 'simple';
      const worktreeName = options.worktreeName;
      let directoryCreated = false;
      let spawnDirectory = directory;
      let worktreeInfo: WorktreeInfo | null = null;
      let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;
      let managedLaunch: PreparedManagedLaunch | null = null;
      let spawnedPid: number | null = null;
      let admission: SpawnAdmission;
      let admissionCommitted = false;
      let managedSpawnCommitted = false;
      let rejectedSpawnProvenEmpty = false;
      let markSpawnLifecycleStoreReady: (() => void) | null = null;

      try {
        admission = await admissionController.begin(async () => {
          if (worktreeInfo) {
            await removeWorktree({ repoRoot: worktreeInfo.basePath, worktreePath: worktreeInfo.worktreePath });
          }
        });
      } catch (error) {
        return { type: 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      }

      const initialProbe = await privacyPreflight.ensureWorkdirAllowed(directory);
      if (!initialProbe.ok) {
        await admissionController.cancel(admission.id);
        return { type: 'error', errorMessage: `Workspace privacy preflight failed for '${initialProbe.path}' (${initialProbe.code})` };
      }

      if (sessionType === 'simple') {
        try {
          await fs.access(directory);
          logger.debug(`[RUNNER RUN] Directory exists: ${directory}`);
        } catch (error) {
          logger.debug(`[RUNNER RUN] Directory doesn't exist, creating: ${directory}`);

          // Check if directory creation is approved
          if (!approvedNewDirectoryCreation) {
            logger.debug(`[RUNNER RUN] Directory creation not approved for: ${directory}`);
            await admissionController.cancel(admission.id);
            return {
              type: 'requestToApproveDirectoryCreation',
              directory
            };
          }

          try {
            await fs.mkdir(directory, { recursive: true });
            logger.debug(`[RUNNER RUN] Successfully created directory: ${directory}`);
            directoryCreated = true;
          } catch (mkdirError: any) {
            let errorMessage = `Unable to create directory at '${directory}'. `;

            // Provide more helpful error messages based on the error code
            if (mkdirError.code === 'EACCES') {
              errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
            } else if (mkdirError.code === 'ENOTDIR') {
              errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
            } else if (mkdirError.code === 'ENOSPC') {
              errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
            } else if (mkdirError.code === 'EROFS') {
              errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
            } else {
              errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
            }

            logger.debug(`[RUNNER RUN] Directory creation failed: ${errorMessage}`);
            await admissionController.cancel(admission.id);
            return {
              type: 'error',
              errorMessage
            };
          }
        }
      } else {
        try {
          await fs.access(directory);
          logger.debug(`[RUNNER RUN] Worktree base directory exists: ${directory}`);
        } catch (error) {
          logger.debug(`[RUNNER RUN] Worktree base directory missing: ${directory}`);
          await admissionController.cancel(admission.id);
          return {
            type: 'error',
            errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`
          };
        }
      }

      if (sessionType === 'worktree') {
        const worktreeResult = await createWorktree({
          basePath: directory,
          nameHint: worktreeName,
          signal: admission.abortController.signal
        });
        if (!worktreeResult.ok) {
          logger.debug(`[RUNNER RUN] Worktree creation failed: ${worktreeResult.error}`);
          await admissionController.cancel(admission.id);
          return {
            type: 'error',
            errorMessage: worktreeResult.error
          };
        }
        worktreeInfo = worktreeResult.info;
        spawnDirectory = worktreeInfo.worktreePath;
        logger.debug(`[RUNNER RUN] Created worktree ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch})`);
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
        if (admission.abortController.signal.aborted) throw new Error('Spawn preparation was cancelled because the runner is draining');


        // Resolve authentication token if provided
        let extraEnv: Record<string, string> = getRunnerAgentEnv(agent);
        if (agent === 'codex' && !options.token) {
          await ensureManagedCodexHome();
        }
        if (options.token) {
          if (agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'hapi-codex-'));

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir, 'auth.json'), options.token);

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexHomeDir
            };
          } else if (agent === 'claude') {
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

        const finalProbe = await privacyPreflight.ensureWorkdirAllowed(spawnDirectory, { exact: true });
        if (!finalProbe.ok) throw new Error(`Workspace privacy preflight failed for '${finalProbe.path}' (${finalProbe.code})`);
        if (admission.abortController.signal.aborted) throw new Error('Spawn preparation was cancelled because the runner is draining');
        await admissionController.markReserved(admission.id);
        const resumeProfileFingerprint = createRunnerResumeProfileFingerprint(agent, spawnDirectory, options, yolo);
        managedLaunch = managedLaunches ? await managedLaunches.reserve(agent, {
          ...(options.resumeSessionId ? { nativeResumeId: options.resumeSessionId } : {}),
          resumeProfileFingerprint
        }, spawnRequestId) : null;
        if (managedLaunch) {
          await spawnRequestStore.attachLaunchIdentity(spawnRequestId, {
            launchNonce: managedLaunch.launchNonce,
            runnerInstanceId: managedLaunch.runnerInstanceId
          });
        }
        const args = buildCliArgs(agent, options, yolo, managedLaunch ?? undefined);

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
          logger.debug(`[RUNNER RUN] Child stderr captured (${Buffer.byteLength(trimmed, 'utf8')} bytes; body suppressed)`);
        };

        happyProcess = spawnHappyCLI(args, {
          cwd: spawnDirectory,
          detached: true,  // Sessions stay alive when runner stops
          replaceEnv: true,
          stdio: managedLaunch ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          env: {
            ...getSanitizedRunnerChildEnv(agent, process.env),
            ...getRunnerBaseEnv(process.env),
            ...extraEnv,
            HAPI_HOME: configuration.happyHomeDir,
            ...(managedLaunch ? {
              HAPI_LAUNCH_NONCE: managedLaunch.launchNonce,
              HAPI_RUNNER_INSTANCE_ID: managedLaunch.runnerInstanceId,
              HAPI_MANAGED_OUTCOME_FD: '3',
              ...(managedLaunch.resumeProfileFingerprint
                ? {
                  HAPI_RESUME_PROFILE_FINGERPRINT: managedLaunch.resumeProfileFingerprint,
                  ...(managedLaunch.nativeResumeId ? { HAPI_EXPECTED_NATIVE_RESUME_ID: managedLaunch.nativeResumeId } : {})
                }
                : {})
            } : {})
          }
        });

        let routedExitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
        let routedErrorHandler: ((error: Error) => void) | null = null;
        let pendingEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        let pendingEarlyError: Error | null = null;
        happyProcess.on('exit', (code, signal) => {
          if (routedExitHandler) routedExitHandler(code, signal);
          else pendingEarlyExit = { code, signal };
        });
        happyProcess.on('error', (error) => {
          if (routedErrorHandler) routedErrorHandler(error);
          else pendingEarlyError = error;
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
          if (managedLaunch && managedLaunches) {
            const absent = await terminalizeLaunchIfVerifiedAbsent(managedLaunch).catch(() => false);
            await managedLaunches.recordSpawnFailure(managedLaunch, null, absent).catch((journalError) => {
              logger.debug('[RUNNER RUN] Failed to terminalize no-PID managed launch', journalError);
            });
          }
          await maybeCleanupWorktree('no-pid');
          await admissionController.cancel(admission.id);
          return {
            type: 'error',
            errorMessage
          };
        }
        happyProcess.removeListener('error', captureSpawnErrorBeforePidCheck);

        const pid = happyProcess.pid;
        spawnedPid = pid;
        let observedExitCode: number | null = null;
        let observedExitSignal: NodeJS.Signals | null = null;
        let lifecycleHandlersActive = false;
        let lifecycleStoreReady = false;
        let resolveLifecycleStoreReady: (() => void) | null = null;
        const lifecycleStoreReadyPromise = new Promise<void>((resolve) => {
          resolveLifecycleStoreReady = resolve;
        });
        markSpawnLifecycleStoreReady = () => {
          if (lifecycleStoreReady) return;
          lifecycleStoreReady = true;
          resolveLifecycleStoreReady?.();
          resolveLifecycleStoreReady = null;
        };
        const buildWebhookFailureMessage = (): string => {
          let message = `Session process exited before webhook for PID ${pid}`;

          if (observedExitCode !== null || observedExitSignal) {
            if (observedExitCode !== null) {
              message += ` (exit code ${observedExitCode})`;
            } else {
              message += ` (signal ${observedExitSignal})`;
            }
          }

          const trimmedTail = stderrTail.trim();
          if (trimmedTail) {
            message += `. stderr captured (${Buffer.byteLength(trimmedTail, 'utf8')} bytes; body suppressed)`;
          }

          return message;
        };
        const trackedSession: TrackedSession = {
          startedBy: 'runner',
          pid,
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };
        const activateLifecycleHandlers = () => {
          if (lifecycleHandlersActive) return;
          lifecycleHandlersActive = true;
          pidToTrackedSession.set(pid, trackedSession);
          routedExitHandler = (code, signal) => {
            observedExitCode = typeof code === 'number' ? code : null;
            observedExitSignal = signal ?? null;
            logger.debug(`[RUNNER RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
            if (code !== 0 || signal) {
              logStderrTail();
            }
            void settleSpawnRequestAfterExit({
              proveProcessGroupEmpty: async () => await trackJournalWrite(recordManagedExit(pid, observedExitCode)),
              completeTerminalError: async () => {
                if (managedLaunch) {
                  await settleVerifiedEmptySpawnRequest(
                    managedLaunch.launchNonce,
                    buildWebhookFailureMessage()
                  );
                } else {
                  // Non-journal platforms retain the legacy PID-scoped path.
                  await lifecycleStoreReadyPromise;
                  await spawnRequestStore.completeErrorByPid(pid, buildWebhookFailureMessage());
                }
              }
            }).catch((error) => {
              logger.debug(`[RUNNER RUN] Keeping spawn request pending after unproven exit for PID ${pid}`, error);
            });
            onChildExited(pid);
          };

          routedErrorHandler = (error) => {
            logger.debug(`[RUNNER RUN] Child process error:`, error);
            // ChildProcess 'error' is a transport/control-plane signal, not proof
            // that the detached child or its process group is gone. The exit
            // path or startup reconciliation will terminalize only with absence
            // proof; a late canonical webhook remains able to complete success.
            logStderrTail();
          };
          if (pendingEarlyExit) {
            const early = pendingEarlyExit as { code: number | null; signal: NodeJS.Signals | null };
            pendingEarlyExit = null;
            routedExitHandler(early.code, early.signal);
          } else if (pendingEarlyError) {
            const early = pendingEarlyError;
            pendingEarlyError = null;
            routedErrorHandler(early);
          }
        };
        const closeManagedSigningPipeWithoutContext = (): void => {
          const signingPipe = happyProcess?.stdio[3];
          if (!signingPipe || typeof (signingPipe as NodeJS.WritableStream).end !== 'function') return;
          const stream = signingPipe as NodeJS.WritableStream;
          stream.once('error', (pipeError) => {
            logger.debug('[RUNNER RUN] Failed to close empty managed signing descriptor', pipeError);
          });
          // Bun's child-process pipe does not reliably wake a synchronous
          // reader for a zero-byte end. A whitespace-only sentinel preserves
          // the recoverable empty-context semantics while forcing delivery.
          stream.end('\n');
        };
        if (managedLaunch) {
          pendingManagedLaunches.set(pid, {
            launchNonce: managedLaunch.launchNonce,
            runnerInstanceId: managedLaunch.runnerInstanceId
          });
          if (integrationManagedCommitDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, integrationManagedCommitDelayMs));
          }
          if (managedLaunches) {
            try {
              await managedLaunches.commitSpawn(managedLaunch, pid);
              managedSpawnCommitted = true;
              // From this point onward any signing/admission/store await may
              // fail while the child remains alive. Route lifecycle events
              // before the first such await so exits cannot be stranded.
              activateLifecycleHandlers();
            } catch (error) {
              // Release the child's inherited read end even when identity
              // commit fails. Production providers can then treat empty EOF as
              // recoverable and either report to a successor or exit normally.
              closeManagedSigningPipeWithoutContext();
              const processGroupProvenEmpty = await terminateRejectedManagedSpawn(pid);
              rejectedSpawnProvenEmpty ||= processGroupProvenEmpty;
              const exactLaunchAbsent = processGroupProvenEmpty
                || await terminalizeLaunchIfVerifiedAbsent(managedLaunch).catch(() => false);
              rejectedSpawnProvenEmpty ||= exactLaunchAbsent;
              await managedLaunches.recordSpawnFailure(
                managedLaunch,
                pendingEarlyExit ? (pendingEarlyExit as { code: number | null }).code : null,
                exactLaunchAbsent
              ).catch((journalError) => logger.debug('[RUNNER RUN] Failed to terminalize pre-commit spawn', journalError));
              if (!exactLaunchAbsent) {
                // commitSpawn did not establish a durable PID backlink, so a
                // normal ChildProcess exit must settle by exact launch identity
                // rather than by volatile PID.
                routedExitHandler = (code, signal) => {
                  observedExitCode = typeof code === 'number' ? code : null;
                  observedExitSignal = signal ?? null;
                  void (async () => {
                    const absent = await terminalizeLaunchIfVerifiedAbsent(managedLaunch!);
                    if (!absent) return;
                    await settleVerifiedEmptySpawnRequest(
                      managedLaunch!.launchNonce,
                      buildWebhookFailureMessage()
                    );
                  })().catch((settlementError) => {
                    logger.debug(`[RUNNER RUN] Failed to settle exact pre-commit exit for PID ${pid}`, settlementError);
                  });
                  onChildExited(pid);
                };
                routedErrorHandler = (childError) => {
                  logger.debug('[RUNNER RUN] Pre-commit child process error:', childError);
                  logStderrTail();
                };
                if (pendingEarlyExit) {
                  const early = pendingEarlyExit as { code: number | null; signal: NodeJS.Signals | null };
                  pendingEarlyExit = null;
                  routedExitHandler(early.code, early.signal);
                } else if (pendingEarlyError) {
                  const early = pendingEarlyError;
                  pendingEarlyError = null;
                  routedErrorHandler(early);
                }
              }
              throw error;
            }
          }
          const signingPipe = happyProcess.stdio[3];
          if (!signingPipe || typeof (signingPipe as NodeJS.WritableStream).write !== 'function') {
            throw new Error('managed outcome signing descriptor was not inherited by child');
          }
          await new Promise<void>((resolve, reject) => {
            const stream = signingPipe as NodeJS.WritableStream;
            const onError = (error: Error) => reject(error);
            stream.once('error', onError);
            stream.end(JSON.stringify({
              launchNonce: managedLaunch!.launchNonce,
              runnerInstanceId: managedLaunch!.runnerInstanceId,
              privateKey: managedLaunch!.privateKey
            }), () => {
              stream.removeListener('error', onError);
              resolve();
            });
          });
        }
        await admissionController.markSpawned(admission.id, async () => {
          if (managedLaunch && managedLaunches) {
            const processGroupProvenEmpty = await terminateRejectedManagedSpawn(pid);
            rejectedSpawnProvenEmpty ||= processGroupProvenEmpty;
            await managedLaunches.recordSpawnFailure(managedLaunch, null, processGroupProvenEmpty);
          } else if (happyProcess) {
            await killProcessByChildProcess(happyProcess, true);
          }
        });
        if (integrationAttachPidFailuresRemaining > 0) {
          integrationAttachPidFailuresRemaining -= 1;
          throw new Error('Injected integration spawn-request PID attachment failure');
        }
        await spawnRequestStore.attachPid(spawnRequestId, pid, managedLaunch ? {
          launchNonce: managedLaunch.launchNonce,
          runnerInstanceId: managedLaunch.runnerInstanceId
        } : undefined);
        markSpawnLifecycleStoreReady();
        await admissionController.commit(admission.id);
        admissionCommitted = true;
        logger.debug(`[RUNNER RUN] Spawned process with PID ${pid}`);
        activateLifecycleHandlers();
        pendingManagedLaunches.delete(pid);
        const earlyWebhook = earlyManagedWebhooks.get(pid);
        if (earlyWebhook) {
          try {
            const accepted = managedLaunches
              ? await acceptManagedWebhook(pid, earlyWebhook.sessionId, earlyWebhook.metadata)
              : true;
            if (accepted) {
              earlyManagedWebhooks.delete(pid);
              trackedSession.happySessionId = earlyWebhook.sessionId;
              trackedSession.happySessionMetadataFromLocalWebhook = earlyWebhook.metadata;
            } else {
              logger.debug(`[RUNNER RUN] Retaining buffered managed webhook for PID ${pid} until durable settlement`);
            }
          } catch (error) {
            // The child already received a non-2xx response for this early
            // delivery and will retry. Keep both the buffer and lifecycle
            // handlers alive instead of turning a transient persistence error
            // into an unobserved child exit.
            logger.debug(`[RUNNER RUN] Retaining buffered managed webhook after settlement failure for PID ${pid}`, error);
          }
        }

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[RUNNER RUN] Waiting for session webhook for PID ${pid}`);

        if (trackedSession.happySessionId) {
          reportSpawnOutcomeToHub?.({ type: 'success' });
          return { type: 'success', sessionId: trackedSession.happySessionId };
        }

        const spawnResult = await spawnRequestStore.waitForResult(spawnRequestId, 15_000);
        if (spawnResult.type === 'pending') {
          logger.debug(`[RUNNER RUN] Session webhook still pending for PID ${pid}; request ${spawnRequestId} remains queryable`);
          logStderrTail();
        }
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
        } else if (spawnResult.type === 'success') {
          reportSpawnOutcomeToHub?.({ type: 'success' });
        }
        return spawnResult;
      } catch (error) {
        if (spawnedPid !== null) pendingManagedLaunches.delete(spawnedPid);
        if (admissionCommitted) {
          const recovered = await recoverCommittedSpawnResult(spawnRequestStore, spawnRequestId);
          logger.debug(
            `[RUNNER RUN] Spawn bookkeeping failed after admission commit; preserving request ${spawnRequestId} as ${recovered.type}`,
            error
          );
          if (recovered.type === 'success') reportSpawnOutcomeToHub?.({ type: 'success' });
          return recovered;
        }
        let processGroupProvenEmpty = rejectedSpawnProvenEmpty || happyProcess === null;
        const managedPreCommitFailure = Boolean(
          !admissionCommitted && managedLaunch && managedLaunches && !managedSpawnCommitted
        );
        if (!admissionCommitted && managedLaunch && managedLaunches && !managedSpawnCommitted) {
          if (!processGroupProvenEmpty && spawnedPid !== null && managedLaunches.launchNonceForPid(spawnedPid)) {
            processGroupProvenEmpty = await terminateRejectedManagedSpawn(spawnedPid);
          }
          if (!processGroupProvenEmpty) {
            processGroupProvenEmpty = await terminalizeLaunchIfVerifiedAbsent(managedLaunch).catch(() => false);
          }
          await managedLaunches.recordSpawnFailure(managedLaunch, null, processGroupProvenEmpty).catch((journalError) => {
            logger.debug('[RUNNER RUN] Failed to terminalize rejected managed launch', journalError);
          });
        }
        if (spawnedPid !== null) {
          const managedIdentity = managedLaunch ? {
            launchNonce: managedLaunch.launchNonce,
            runnerInstanceId: managedLaunch.runnerInstanceId
          } : undefined;
          // A failed pre-commit identity read has no durable journal PID. Never
          // persist the volatile ChildProcess PID into the request store; the
          // exact launch identity is sufficient for successor adoption or
          // verified-empty settlement and avoids an unrecoverable PID mismatch.
          if (!managedPreCommitFailure) {
            if (processGroupProvenEmpty) {
              let storeBound = false;
              await spawnRequestStore.attachPid(spawnRequestId, spawnedPid, managedIdentity).then(() => {
                storeBound = true;
              }).catch((storeError) => {
                logger.debug(`[RUNNER RUN] Failed to bind rejected spawn request ${spawnRequestId} to PID ${spawnedPid}`, storeError);
              });
              if (storeBound) markSpawnLifecycleStoreReady?.();
            } else {
              await spawnRequestStore.preservePendingForAmbiguousSpawn(spawnRequestId, spawnedPid, managedIdentity);
              markSpawnLifecycleStoreReady?.();
            }
          }
          const bufferedWebhook = earlyManagedWebhooks.get(spawnedPid);
          if (bufferedWebhook) {
            const accepted = await acceptManagedWebhook(spawnedPid, bufferedWebhook.sessionId, bufferedWebhook.metadata).catch((webhookError) => {
              logger.debug(`[RUNNER RUN] Failed to settle buffered webhook for ambiguous spawn ${spawnRequestId}`, webhookError);
              return false;
            });
            if (accepted) earlyManagedWebhooks.delete(spawnedPid);
          }
          const recovered = await recoverCommittedSpawnResult(spawnRequestStore, spawnRequestId);
          if (recovered.type === 'success' || !processGroupProvenEmpty) {
            await admissionController.preserveAmbiguousSpawn(admission.id);
            if (recovered.type === 'success') {
              reportSpawnOutcomeToHub?.({ type: 'success' });
              return recovered;
            }
            logger.debug(`[RUNNER RUN] Spawn failure is unproven; preserving request ${spawnRequestId} as pending`, error);
            return { type: 'pending', spawnRequestId };
          }
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[RUNNER RUN] Failed to spawn session:', error);
        await maybeCleanupWorktree('exception');
        if (!admissionCommitted) await admissionController.cancel(admission.id);
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

    const spawnSessionOnce = async (
      options: SpawnSessionOptions & { spawnRequestId: string }
    ): Promise<SpawnSessionResult> => {
      if (process.env.NODE_ENV === 'test' && process.env.HAPI_RUNNER_INTEGRATION_FIXTURE === '1') {
        return await spawnSessionAfterProviderReadiness(options);
      }
      const flavor = options.agent ?? 'claude';
      return await runWithProviderSpawnReadiness({
        flavor,
        selection: {
          model: resolveRunnerReadinessModel(flavor, options.model),
          effort: flavor === 'codex' ? options.modelReasoningEffort : options.effort,
          mode: options.permissionMode,
          yolo: options.yolo,
          resume: Boolean(options.resumeSessionId),
          requestTokenAuth: Boolean(options.token) && (flavor === 'claude' || flavor === 'codex')
        },
        source: activeProviderReadiness,
        publish: publishProviderReadiness
      }, async () => await spawnSessionAfterProviderReadiness(options));
    };

    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      const normalizedOptions: SpawnSessionOptions & { spawnRequestId: string } = {
        ...options,
        spawnRequestId: options.spawnRequestId ?? randomUUID()
      };
      const fingerprint = fingerprintSpawnSessionOptions(normalizedOptions);
      const legacyFingerprint = fingerprintLegacySpawnSessionOptions(normalizedOptions);
      let started: Awaited<ReturnType<SpawnRequestStore['begin']>>;
      try {
        started = await spawnRequestStore.begin(
          normalizedOptions.spawnRequestId,
          fingerprint,
          legacyFingerprint === fingerprint ? [] : [legacyFingerprint]
        );
      } catch (error) {
        return {
          type: 'error',
          errorMessage: error instanceof Error ? error.message : String(error)
        };
      }
      if (!started.created) return started.result;

      const result = await spawnSessionOnce(normalizedOptions);
      if (result.type === 'pending') return result;
      return await spawnRequestStore.complete(normalizedOptions.spawnRequestId, result);
    };

    const querySpawnSession = async (
      spawnRequestId: string,
      expectedOptions?: SpawnSessionOptions
    ): Promise<QuerySpawnSessionResult> => {
      const normalizedExpected = expectedOptions
        ? { ...expectedOptions, spawnRequestId }
        : undefined;
      const fingerprint = normalizedExpected
        ? fingerprintSpawnSessionOptions(normalizedExpected)
        : undefined;
      const legacyFingerprint = normalizedExpected
        ? fingerprintLegacySpawnSessionOptions(normalizedExpected)
        : undefined;
      return await querySpawnRequest(
        spawnRequestStore,
        spawnRequestId,
        fingerprint,
        fingerprint && legacyFingerprint && fingerprint !== legacyFingerprint
          ? [legacyFingerprint]
          : []
      );
    };

    const terminateVerifiedManagedSession = async (session: TrackedSession): Promise<boolean> => {
      if (!managedLaunches || session.startedBy !== 'runner') return false;
      try {
        const launchNonce = managedLaunches.launchNonceForPid(session.pid);
        if (!launchNonce) return false;
        const finalizeProvenEmptySpawn = async (): Promise<true> => {
          await managedLaunches.terminalizeVerifiedAbsent(launchNonce);
          await settleVerifiedEmptySpawnRequest(
            launchNonce,
            `Managed launch ${launchNonce} was stopped before session registration completed`
          );
          return true;
        };
        let identity = await managedLaunches.writeRecycleIntent(session.pid);
        let group = await readProcessGroupEvidence(identity.pgid);
        if (group.complete && group.members.length === 0) return await finalizeProvenEmptySpawn();
        if (!isCompleteOwnedProcessGroup(identity, group)) return false;
        process.kill(-identity.pgid, 'SIGTERM');
        const termDeadline = Date.now() + RUNNER_TIMING.termGraceMs;
        while (Date.now() < termDeadline) {
          const group = await readProcessGroupEvidence(identity.pgid);
          if (group.complete && group.members.length === 0) return await finalizeProvenEmptySpawn();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        identity = await managedLaunches.writeRecycleIntent(session.pid);
        group = await readProcessGroupEvidence(identity.pgid);
        if (group.complete && group.members.length === 0) return await finalizeProvenEmptySpawn();
        if (!isCompleteOwnedProcessGroup(identity, group)) return false;
        process.kill(-identity.pgid, 'SIGKILL');
        const killDeadline = Date.now() + RUNNER_TIMING.killSettlementMs;
        while (Date.now() < killDeadline) {
          const group = await readProcessGroupEvidence(identity.pgid);
          if (group.complete && group.members.length === 0) {
            await managedLaunches.recordForcedOutcome(launchNonce, 'runner-recycle-sigkill');
            await flushManagedOutcomes();
            return await finalizeProvenEmptySpawn();
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      } catch (error) {
        logger.debug(`[RUNNER RUN] Refusing unverified managed termination for PID ${session.pid}`, error);
        return false;
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (sessionId: string): Promise<boolean> => {
      logger.debug(`[RUNNER RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'runner' && managedLaunches) {
            if (!await terminateVerifiedManagedSession(session)) return false;
          } else {
            logger.debug(`[RUNNER RUN] Refusing PID-only termination for externally reported session ${sessionId}`);
            return false;
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[RUNNER RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[RUNNER RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[RUNNER RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startRunnerControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      querySpawnSession,
      requestShutdown: () => requestShutdown('hapi-cli'),
      onHappySessionWebhook,
      onManagedOutcome: async (envelope: SignedManagedOutcome) => {
        if (!managedOutcomeMailbox || !verifiedOwnership) return { acknowledged: false };
        await managedOutcomeMailbox.ingest(envelope);
        await flushManagedOutcomes();
        const pending = (await verifiedOwnership.journal.snapshot()).outbox
          .some((item) => item.outcomeId === envelope.idempotencyKey);
        return { acknowledged: !pending };
      },
      onNativeIdentity: async (input) => {
        if (!managedLaunches || managedLaunches.launchNonceForPid(input.pid) !== input.launchNonce) {
          return { acknowledged: false };
        }
        try {
          await managedLaunches.recordNativeIdentity(input.pid, {
            nativeResumeId: input.nativeResumeId,
            resumeProfileFingerprint: input.resumeProfileFingerprint
          });
          return { acknowledged: true };
        } catch (error) {
          logger.debug(`[RUNNER RUN] Native identity rejected for PID ${input.pid}`, error);
          const tracked = pidToTrackedSession.get(input.pid);
          await terminateVerifiedManagedSession(tracked?.startedBy === 'runner'
            ? tracked
            : { startedBy: 'runner', pid: input.pid });
          return { acknowledged: false };
        }
      }
    });

    const startedWithCliMtimeMs = getInstalledCliMtimeMs();

    // Write initial runner state (no lock needed for state file)
    const fileState: RunnerLocallyPersistedState = {
      pid: process.pid,
      runnerInstanceId,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
      startedWithApiUrl: configuration.apiUrl,
      startedWithMachineId: machineId,
      startedWithCliApiTokenHash: hashRunnerCliApiToken(configuration.cliApiToken),
      runnerLogPath: logger.logFilePath
    };
    writeRunnerState(fileState);
    logger.debug('[RUNNER RUN] Runner state written');

    // Prepare initial runner state
    const initialRunnerState: RunnerState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create();

    // Get or create machine (with retry for transient connection errors)
    const machine = await withRetry(
      () => api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata(initialProviderReadiness),
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
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      querySpawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('hapi-app')
    });
    const providerReadinessPublisher = createProviderReadinessPublisher(
      activeProviderReadiness,
      async (snapshot) => {
        await apiMachine.updateMachineMetadata((current) => buildMachineMetadata(snapshot, current));
      }
    );
    publishProviderReadiness = providerReadinessPublisher.publish;

    // Connect to server and version-publish the current snapshot so an
    // existing machine cannot retain historical readiness metadata.
    const hubAvailable = await connectAndPublishProviderReadiness(
      apiMachine,
      activeProviderReadiness,
      15_000,
      providerReadinessPublisher.publish
    );

    if (managedOutcomeMailbox && verifiedOwnership) {
      performManagedOutcomeDrain = async () => {
        await ingestManagedOutcomeSpools(managedOutcomeMailbox, configuration.runnerManagedOutboxDir);
        return await managedOutcomeMailbox.flush(async (item) => {
          const snapshot = await verifiedOwnership.journal.snapshot();
          const launch = snapshot.launches[item.launchNonce];
          if (!launch?.hapiSessionId) return { acknowledged: false };
          const answer = await apiMachine.markManagedSessionOutcome({
            idempotencyKey: item.outcomeId,
            namespace: machine.namespace,
            machineId: machine.id,
            sessionId: launch.hapiSessionId,
            launchNonce: item.launchNonce,
            runnerInstanceId: launch.runnerInstanceId,
            expectedVersion: null,
            lifecycleState: item.lifecycleState,
            active: item.lifecycleState === 'running',
            stoppedBy: item.stoppedBy,
            stopReasonCode: item.stopReasonCode,
            lifecycleStateSince: Date.parse(item.writtenAt)
          });
          return { acknowledged: answer.result === 'success' };
        });
      };
      await flushManagedOutcomes();
    }

    // Capture one point-in-time process table for the complete proof-only
    // startup sweep. Exact kernel identity reads remain per candidate, while
    // retained launches no longer fork one full `ps` process each.
    const startupEvidenceSweep = verifiedOwnership
      ? await createProcessEvidenceSweep()
      : null;

    if (verifiedOwnership && startupEvidenceSweep) {
      const stoppedLaunchProofs = await reconcileStoppedLaunchProofs({
        journal: verifiedOwnership.journal,
        readGroup: startupEvidenceSweep.readProcessGroupEvidence
      });
      for (const result of stoppedLaunchProofs) {
        if (result.outcome === 'retained-unproven') {
          logger.debug(`[RUNNER RUN] Retaining stopped launch ${result.launchNonce}; no recorded process group is proven empty`);
        }
      }
      const stoppedSnapshot = await verifiedOwnership.journal.snapshot();
      await settleProvenEmptyLaunchRequests({
        launches: stoppedSnapshot.launches,
        settle: async (launch) => {
          await convergeProvenEmptyLaunchRequest(
            launch,
            'Managed spawn ended before session registration after Runner restart'
          );
        }
      });
    }

    if (verifiedOwnership && startupEvidenceSweep) {
      const snapshot = await verifiedOwnership.journal.snapshot();
      const terminalized = await reconcileAdmittedLaunchAbsence({
        launches: snapshot.launches,
        findEvidence: async (record) => await startupEvidenceSweep.findManagedProcessEvidence(
          record.launchNonce,
          record.runnerInstanceId,
          2
        ),
        terminalize: async (launchNonce) => {
          await managedLaunches?.terminalizeVerifiedAbsent(launchNonce);
        }
      });
      if (terminalized.length > 0) {
        logger.debugLargeJson('[RUNNER RUN] Terminalized admitted launches proven absent at startup', terminalized);
      }
    }

    // Exact single-process adoption is non-destructive recovery, not stale
    // process enforcement. Run it even when reconciliation mode is off and
    // allow a verified successor to hydrate predecessor launch bindings.
    const adoptedLaunchNonces = new Set<string>();
    if (verifiedOwnership && startupEvidenceSweep) {
      const snapshot = await verifiedOwnership.journal.snapshot();
      for (const record of Object.values(snapshot.launches).filter((item) => item.lifecycle !== 'stopped')) {
        const evidence = await startupEvidenceSweep.findManagedProcessEvidence(
          record.launchNonce,
          record.runnerInstanceId,
          2
        );
        const validMatches = evidence.matches.filter((identity) => identity.executableRealpath === record.runtimeRealpath);
        if (!evidence.complete || evidence.matches.length !== 1 || validMatches.length !== 1) continue;
        const identity = validMatches[0];
        try {
          await managedLaunches?.adopt(record, identity);
          adoptedLaunchNonces.add(record.launchNonce);
          pidToTrackedSession.set(identity.pid, {
            startedBy: 'runner',
            pid: identity.pid,
            happySessionId: record.hapiSessionId
          });
        } catch (error) {
          logger.debug(`[RUNNER RUN] Refusing non-destructive adoption for launch ${record.launchNonce}`, error);
        }
      }
    }

    if (verifiedOwnership && startupEvidenceSweep) {
      const snapshot = await verifiedOwnership.journal.snapshot();
      const terminalized = await reconcileNonDestructiveLaunchAbsence({
        launches: snapshot.launches,
        excludedLaunchNonces: adoptedLaunchNonces,
        findEvidence: async (record) => await startupEvidenceSweep.findManagedProcessEvidence(
          record.launchNonce,
          record.runnerInstanceId,
          2
        ),
        readGroup: startupEvidenceSweep.readProcessGroupEvidence,
        groupProbeAttempts: 1,
        terminalize: async (launchNonce) => {
          await managedLaunches?.terminalizeVerifiedAbsent(launchNonce);
        }
      });
      if (terminalized.length > 0) {
        logger.debugLargeJson('[RUNNER RUN] Non-destructively terminalized launches proven absent at startup', terminalized);
      }
    }

    if (verifiedOwnership && reconcileConfig.mode !== 'off') {
      const snapshot = await verifiedOwnership.journal.snapshot();
      const activeRecords = Object.values(snapshot.launches).filter((record) => record.lifecycle !== 'stopped');
      const records = activeRecords.filter((record) => !adoptedLaunchNonces.has(record.launchNonce));
      const duplicateGroups = new Set<number>();
      const seenGroups = new Set<number>();
      for (const record of activeRecords) {
        if (!record.pgid) continue;
        if (seenGroups.has(record.pgid)) duplicateGroups.add(record.pgid);
        seenGroups.add(record.pgid);
      }
      const readReconciliationKillSwitch = createRunnerReconciliationKillSwitchReader({
        initialConfig: reconcileConfig,
        readConfig: async () => await readRunnerReconcileConfig(configuration.happyHomeDir),
        assertOwnershipHealthy: () => verifiedOwnership.helper.assertHealthy(),
        preflightEligible: preflightResult.enforceEligible,
        ownershipEligible: verifiedOwnership.reconciliationEnforcementAllowed,
        launchContextEligible
      });
      const results = await reconcileLaunches(records, {
        currentRunnerInstanceId: runnerInstanceId,
        currentUid: process.getuid?.() ?? -1,
        hubAvailable,
        helperHealthy: (() => {
          try {
            verifiedOwnership.helper.assertHealthy();
            return true;
          } catch {
            return false;
          }
        })(),
        deadlineAt: Date.now() + RUNNER_TIMING.reconciliationMs,
        readEvidence: async (record) => {
          const leader = record.pid ? await readProcessIdentity(record.pid) : null;
          const groupEvidence = record.pgid
            ? await readProcessGroupEvidence(record.pgid).catch(() => ({ members: [], complete: false }))
            : { members: [], complete: false };
          const owner = await readProcessIdentity(record.runnerPid);
          const barrier = record.hapiSessionId ? await apiMachine.checkManagedStopBarrier({
            namespace: machine.namespace,
            machineId: machine.id,
            sessionId: record.hapiSessionId,
            launchNonce: record.launchNonce,
            runnerInstanceId: record.runnerInstanceId
          }) : { eligible: false, reason: 'session-not-bound' };
          return {
            leader,
            group: groupEvidence.members,
            groupComplete: groupEvidence.complete,
            ownerAlive: Boolean(owner && owner.birthToken === record.runnerBirthToken),
            conflictingClaim: Boolean(record.pgid && duplicateGroups.has(record.pgid)),
            hubStopEligible: barrier.eligible
          };
        },
        writeIntent: async (record, reason) => {
          if (!record.pid || !record.birthToken) throw new Error('cannot write stop intent without committed identity');
          await verifiedOwnership.journal.writeRecycleIntent(record.launchNonce, {
            pid: record.pid, birthToken: record.birthToken, reason
          });
        },
        signalGroup: async (pgid, signal) => { process.kill(-pgid, signal); },
        waitForSettlement: async (record) => {
          const until = Math.min(Date.now() + RUNNER_TIMING.termGraceMs, Date.now() + RUNNER_TIMING.reconciliationMs);
          while (Date.now() < until) {
            const group = record.pgid
              ? await readProcessGroupEvidence(record.pgid).catch(() => ({ members: [], complete: false }))
              : { members: [], complete: false };
            if (group.complete && group.members.length === 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        },
        readKillSwitch: readReconciliationKillSwitch
      });
      for (const result of results) {
        if (!['stopped-term', 'stopped-kill'].includes(result.outcome)) continue;
        const record = records.find((item) => item.launchNonce === result.launchNonce);
        if (!record?.pgid) continue;
        const group = await readProcessGroupEvidence(record.pgid);
        if (group.complete && group.members.length === 0) {
          await managedLaunches?.terminalizeVerifiedAbsent(record.launchNonce);
        }
      }
      const enforcementEnabled = !await readReconciliationKillSwitch();
      logger.debugLargeJson('[RUNNER RUN] Startup ownership reconciliation report', {
        configuredMode: reconcileConfig.mode,
        effectiveMode: enforcementEnabled ? 'enforce' : 'report',
        killSwitch: reconcileConfig.killSwitch,
        preflightEligible: preflightResult.enforceEligible,
        crashLoopEligible: verifiedOwnership.reconciliationEnforcementAllowed,
        launchContextEligible,
        launchContextReason: launchIdentity.reason,
        launchAgentLabel: launchIdentity.label,
        results
      });
    }
    const reconciledJournal = verifiedOwnership
      ? await verifiedOwnership.journal.snapshot()
      : null;
    if (reconciledJournal) {
      await restorePendingLaunchBindings({
        store: spawnRequestStore,
        launches: reconciledJournal.launches
      });
      await spawnRequestStore.markSuccessesReclaimable(
        Object.values(reconciledJournal.launches)
          .filter(hasProvenEmptyProcessGroup)
          .map((launch) => launch.launchNonce)
      ).catch((error) => {
        logger.debug('[RUNNER RUN] Failed to compact proven-empty spawn success records', error);
      });
    }
    const reconciledSpawnRequests = await spawnRequestStore.reconcilePending(async (pending) => (
      resolvePersistedPendingSpawn(
        pending,
        pending.launchNonce ? reconciledJournal?.launches[pending.launchNonce] : undefined
      )
    ));
    if (reconciledSpawnRequests.length > 0) {
      logger.debugLargeJson(
        '[RUNNER RUN] Reconciled persisted spawn requests after startup',
        reconciledSpawnRequests
      );
    }
    if (verifiedOwnership) {
      const compactedLaunches = await verifiedOwnership.journal.compact();
      if (compactedLaunches.length > 0) {
        logger.debugLargeJson('[RUNNER RUN] Compacted retained terminal ownership records', compactedLaunches);
      }
    }
    await admissionController.markReady(isManagedSpawnAdmissionReady({
      journalHealth: verifiedOwnership?.journal.health,
      hubAvailable
    }));
    await apiMachine.updateRunnerState((state) => ({
      ...(state ?? {}),
      status: admissionController.state === 'ready' ? 'ready' : 'ready-no-admission',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: state?.startedAt ?? Date.now()
    }));

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
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;
      try {

      if (verifiedOwnership) {
        try {
          verifiedOwnership.helper.assertHealthy();
        } catch (error) {
          heartbeatRunning = false;
          requestShutdown('exception', `Runner ownership lost: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }

      if (process.env.DEBUG) {
        logger.debug(`[RUNNER RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      try {
        await providerReadinessPublisher.refreshAndPublish();
      } catch (error) {
        logger.debug('[RUNNER RUN] Failed to refresh provider readiness metadata', error);
      }

      await flushManagedOutcomes().catch((error) => {
        logger.debug('[RUNNER RUN] Periodic managed outcome convergence failed', error);
      });

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isProcessAlive(pid)) {
          logger.debug(`[RUNNER RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          const launchNonce = managedLaunches?.launchNonceForPid(pid);
          if (launchNonce) {
            const processGroupProvenEmpty = await trackJournalWrite(recordManagedExit(pid, null)).catch((error) => {
              logger.debug('[RUNNER RUN] Failed to record adopted process exit', error);
              return false;
            });
            if (processGroupProvenEmpty) {
              await settleVerifiedEmptySpawnRequest(
                launchNonce,
                `Managed launch ${launchNonce} exited before session registration completed`
              ).catch((error) => {
                logger.debug(`[RUNNER RUN] Failed to settle adopted process exit for launch ${launchNonce}`, error);
              });
            }
          }
          pidToTrackedSession.delete(pid);
        }
      }

      // Re-run one proof-only process-table sweep. This both re-proves stopped
      // groups that outlived their leader's two-second exit window and converges
      // active mode=off launches, without ever sending a signal.
      if (verifiedOwnership) {
        try {
          const evidenceSweep = await createProcessEvidenceSweep();
          await reconcileStoppedLaunchProofs({
            journal: verifiedOwnership.journal,
            readGroup: evidenceSweep.readProcessGroupEvidence
          });
          const snapshot = await verifiedOwnership.journal.snapshot();
          await settleProvenEmptyLaunchRequests({
            launches: snapshot.launches,
            settle: async (launch) => {
              await convergeProvenEmptyLaunchRequest(
                launch,
                `Managed launch ${launch.launchNonce} exited before session registration completed`
              ).catch((error) => {
                logger.debug(`[RUNNER RUN] Failed to converge proven-empty launch ${launch.launchNonce}`, error);
              });
            }
          });
          const terminalized = await reconcileNonDestructiveLaunchAbsence({
            launches: snapshot.launches,
            findEvidence: async (record) => await evidenceSweep.findManagedProcessEvidence(
              record.launchNonce,
              record.runnerInstanceId,
              1
            ),
            readGroup: evidenceSweep.readProcessGroupEvidence,
            groupProbeAttempts: 1,
            terminalize: async (launchNonce) => {
              await managedLaunches?.terminalizeVerifiedAbsent(launchNonce);
            }
          });
          for (const launchNonce of terminalized) {
            await settleVerifiedEmptySpawnRequest(
              launchNonce,
              `Managed launch ${launchNonce} exited before session registration completed`
            );
          }
        } catch (error) {
          logger.debug('[RUNNER RUN] Non-destructive heartbeat reconciliation was inconclusive', error);
        }
      }

      // Check if runner needs update
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[RUNNER RUN] Runner is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        if (process.env.HAPI_RUNNER_SUPERVISED !== 'foreground') {
          clearInterval(restartOnStaleVersionAndHeartbeat);
          requestShutdown('replacement', 'CLI runtime changed', 75);
          heartbeatRunning = false;
          return;
        }

        // Explicit self-managed foreground mode starts a handoff helper. The
        // helper proves it is waiting before this process releases ownership,
        // then starts the successor only after the old PID is gone.
        try {
          const successor = spawnHappyCLI(['runner', 'restart-after', String(process.pid)], {
            detached: true,
            stdio: ['ignore', 'pipe', 'ignore']
          });
          const exited = successor.exitCode !== null || successor.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
              successor.once('exit', () => resolve());
              successor.once('error', () => resolve());
            });
          const ready = successor.stdout
            ? await waitForForegroundReplacementReady({ stdout: successor.stdout, exited, timeoutMs: 5_000 })
            : false;
          if (!ready) {
            logger.debug('[RUNNER RUN] Replacement handoff helper did not become ready; keeping current runner alive');
            heartbeatRunning = false;
            return;
          }
          successor.stdout?.destroy();
          successor.unref();
        } catch (error) {
          logger.debug('[RUNNER RUN] Failed to spawn replacement handoff helper', error);
          heartbeatRunning = false;
          return;
        }

        clearInterval(restartOnStaleVersionAndHeartbeat);
        requestShutdown('replacement', 'CLI runtime changed after arming replacement handoff', 0);
        heartbeatRunning = false;
        return;
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
          pid: process.pid,
          runnerInstanceId,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          startedWithCliMtimeMs,
          startedWithApiUrl: fileState.startedWithApiUrl,
          startedWithMachineId: fileState.startedWithMachineId,
          startedWithCliApiTokenHash: fileState.startedWithCliApiTokenHash,
          lastHeartbeat: new Date().toLocaleString(),
          runnerLogPath: fileState.runnerLogPath
        };
        writeRunnerState(updatedState);
        if (admissionController.state === 'ready') verifiedOwnership?.markHealthyHeartbeat();
        if (process.env.DEBUG) {
          logger.debug(`[RUNNER RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        verifiedOwnership?.markHeartbeatUnhealthy();
        logger.debug('[RUNNER RUN] Failed to write heartbeat', error);
      }

      } finally {
        heartbeatRunning = false;
      }
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: ShutdownSource, errorMessage?: string, exitCode = 0) => {
      logger.debug(`[RUNNER RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);
      await providerReadiness?.shutdown();
      let lockHealthy = true;
      if (verifiedOwnership) {
        try {
          verifiedOwnership.helper.assertHealthy();
        } catch {
          lockHealthy = false;
        }
      }
      await admissionController.drain(1_000, lockHealthy);

      if (source === 'replacement' && lockHealthy) {
        await Promise.all([...pidToTrackedSession.values()].map(async (session) => {
          if (session.startedBy === 'runner') await terminateVerifiedManagedSession(session);
        }));
      }

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

      if (pendingJournalWrites.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingJournalWrites]),
          new Promise((resolve) => setTimeout(resolve, RUNNER_TIMING.finalFlushMs))
        ]);
      }

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupRunnerState();
      ownershipClosing = true;
      if (verifiedOwnership && lockHealthy) await verifiedOwnership.close(source);
      if (legacyRunnerLockHandle) await releaseRunnerLock(legacyRunnerLockHandle);
      await admissionController.markStopped();

      if (shutdownWatchdog) clearTimeout(shutdownWatchdog);

      logger.debug(`[RUNNER RUN] Cleanup completed, exiting process with code ${exitCode}`);
      process.exit(exitCode);
    };

    logger.debug('[RUNNER RUN] Runner started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage, shutdownRequest.exitCode);
  } catch (error) {
    logger.debug('[RUNNER RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    await providerReadiness?.shutdown().catch(() => undefined);
    if (shutdownWatchdog) clearTimeout(shutdownWatchdog);
    process.exit(shutdownRequested ? requestedShutdownExitCode : 1);
  }
}

export function buildCliArgs(
  agent: string,
  options: SpawnSessionOptions,
  yolo?: boolean,
  managedIdentity?: { launchNonce: string; runnerInstanceId: string },
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (env.NODE_ENV === 'test' && env.HAPI_RUNNER_INTEGRATION_FIXTURE === '1') {
    const fixtureArgs = ['runner', 'integration-fixture-agent'];
    if (managedIdentity) {
      fixtureArgs.push(
        '--hapi-launch-nonce', managedIdentity.launchNonce,
        '--hapi-runner-instance', managedIdentity.runnerInstanceId
      );
    }
    return fixtureArgs;
  }

  const agentCommand = agent === 'codex'
    ? 'codex'
    : agent === 'cursor'
      ? 'cursor'
      : agent === 'agy'
        ? 'agy'
        : agent === 'grok'
          ? 'grok'
        : agent === 'opencode'
          ? 'opencode'
          : agent === HERMES_MOA_AGENT
            ? HERMES_MOA_AGENT
            : 'claude';
  const args = [agentCommand];
  if (options.resumeSessionId) {
    if (agent === 'codex') {
      args.push('resume', options.resumeSessionId);
    } else if (agent === 'cursor') {
      args.push('--resume', options.resumeSessionId);
    } else {
      args.push('--resume', options.resumeSessionId);
    }
  }
  args.push('--hapi-starting-mode', 'remote', '--started-by', 'runner');
  if (isClaudeDeepSeekAgent(agent)) {
    args.push('--hapi-agent', CLAUDE_DEEPSEEK_AGENT);
  }
  if (isClaudeArkAgent(agent)) {
    args.push('--hapi-agent', CLAUDE_ARK_AGENT);
  }
  if (isClaudeApiAgent(agent)) {
    args.push('--hapi-agent', CLAUDE_API_AGENT);
  }
  const effectiveModel = resolveEffectiveRunnerModel(agent, options.model);
  if (effectiveModel) {
    args.push('--model', effectiveModel);
  }
  const effectiveEffort = resolveEffectiveRunnerEffort(agent, options);
  if (effectiveEffort && (isClaudeFamilyAgent(agent) || agent === 'grok')) {
    args.push('--effort', effectiveEffort);
  }
  if (effectiveEffort && agent === 'codex') {
    args.push('--model-reasoning-effort', effectiveEffort);
  }
  const effectiveServiceTier = resolveEffectiveRunnerServiceTier(agent, options.serviceTier);
  if (effectiveServiceTier) {
    args.push('--service-tier', effectiveServiceTier);
  }
  const selectedPermissionMode = options.permissionMode?.trim();
  if (selectedPermissionMode && (PERMISSION_MODES as readonly string[]).includes(selectedPermissionMode)) {
    args.push('--permission-mode', selectedPermissionMode);
  } else if (yolo) {
    args.push('--yolo');
  }
  if (managedIdentity) {
    args.push(
      '--hapi-launch-nonce', managedIdentity.launchNonce,
      '--hapi-runner-instance', managedIdentity.runnerInstanceId
    );
  }
  return args;
}

export function createRunnerResumeProfileFingerprint(
  agent: string,
  path: string,
  options: SpawnSessionOptions,
  yolo?: boolean
): string {
  const effectiveEffort = resolveEffectiveRunnerEffort(agent, options);
  return createResumeProfileFingerprint({
    provider: agent,
    path,
    model: resolveEffectiveRunnerModel(agent, options.model),
    effort: agent === 'codex' ? null : effectiveEffort,
    modelReasoningEffort: agent === 'codex' ? effectiveEffort : null,
    serviceTier: resolveEffectiveRunnerServiceTier(agent, options.serviceTier),
    permissionMode: resolveEffectiveRunnerPermissionMode(agent, options, yolo)
  });
}
