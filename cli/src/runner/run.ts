import fs from 'fs/promises';
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
import { isProcessAlive, isWindows, killProcess, killProcessByChildProcess } from '@/utils/process';
import { PERMISSION_MODES } from '@hapi/protocol/modes';
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
import { scheduleCursorModelsPrewarm } from '@/modules/common/cursorModelsPrewarm';

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
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

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

      if (existingSession && existingSession.startedBy === 'runner') {
        // Update runner-spawned session with reported data
        existingSession.happySessionId = sessionId;
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
          logger.debug(
            `[RUNNER RUN] Ignoring late webhook from orphaned runner-spawned PID ${pid} (session ${sessionId}). Terminating child.`
          );
          // Use killProcess (SIGTERM → SIGKILL escalation) rather than a
          // bare process.kill() so the orphan is reliably reaped even if
          // it ignores SIGTERM.  We don't have a ChildProcess reference
          // here (tracking entry was already removed by the timeout
          // handler), so tree-kill via killProcessByChildProcess is not
          // available — but the timeout handler should have already
          // tree-killed the process group; this is defence-in-depth.
          void killProcess(pid);
          return;
        }

        // New session started externally (terminal)
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
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[RUNNER RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      const agent = options.agent ?? 'claude';
      if (agent === 'gemini') {
        throw new Error('Gemini CLI is no longer supported and cannot be launched (Google sunset the consumer Gemini CLI on 2026-06-18). Existing Gemini sessions remain viewable in the web UI.');
      }
      const yolo = options.yolo === true;
      const sessionType = options.sessionType ?? 'simple';
      const worktreeName = options.worktreeName;
      let directoryCreated = false;
      let spawnDirectory = directory;
      let worktreeInfo: WorktreeInfo | null = null;
      let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;

      if (sessionType === 'simple') {
        const validation = await validateWorkspaceDirectory(directory, {
          approvedNewDirectoryCreation
        });
        if (validation.type === 'requestApproval') {
          logger.debug(`[RUNNER RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }
        if (validation.type === 'error') {
          logger.debug(`[RUNNER RUN] Workspace directory validation failed: ${validation.errorMessage}`);
          return {
            type: 'error',
            errorMessage: validation.errorMessage
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
            errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`
          };
        }
      }

      if (sessionType === 'worktree') {
        // Cursor Agent has native `--worktree` under ~/.cursor/worktrees/. Prefer that
        // over HAPI's sibling-directory worktree so Cursor sandbox/skills see the same layout.
        if (agent === 'cursor') {
          spawnDirectory = directory;
          logger.debug(`[RUNNER RUN] Cursor-native worktree requested (nameHint=${worktreeName ?? '(auto)'})`);
        } else {
          const worktreeResult = await createWorktree({
            basePath: directory,
            nameHint: worktreeName
          });
          if (!worktreeResult.ok) {
            logger.debug(`[RUNNER RUN] Worktree creation failed: ${worktreeResult.error}`);
            return {
              type: 'error',
              errorMessage: worktreeResult.error
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
          await maybeCleanupWorktree('no-pid');
          return {
            type: 'error',
            errorMessage
          };
        }
        happyProcess.removeListener('error', captureSpawnErrorBeforePidCheck);

        const pid = happyProcess.pid;
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
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };

        pidToTrackedSession.set(pid, trackedSession);

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
          onChildExited(pid);
        });

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[RUNNER RUN] Waiting for session webhook for PID ${pid}`);

        const spawnResult = await new Promise<SpawnSessionResult>((resolve) => {
          // Set timeout for webhook. Default is 15s but can be raised via
          // HAPI_RUNNER_WEBHOOK_TIMEOUT_MS for users on slow models
          // (e.g. opus[1m] --resume).
          const timeout = setTimeout(() => {
            pidToAwaiter.delete(pid);
            pidToErrorAwaiter.delete(pid);

            // Remove the tracked session entry so a late-arriving webhook
            // from this orphaned PID cannot be silently promoted into a
            // ghost session by onHappySessionWebhook().
            pidToTrackedSession.delete(pid);

            // Terminate the entire process tree (wrapper + agent
            // grandchildren).  Using killProcessByChildProcess instead of
            // a bare SIGTERM ensures that detached grandchild processes
            // (the actual claude/codex agent) are also reaped, and that
            // SIGTERM → SIGKILL escalation kicks in if needed.
            if (happyProcess) {
              void killProcessByChildProcess(happyProcess);
            }

            // If this was a worktree session, the worktree can only be
            // safely removed after the child has actually exited (the
            // child may still be writing to it).  Register a one-shot
            // exit listener so cleanup happens once the tree-kill lands.
            if (worktreeInfo && happyProcess) {
              happyProcess.once('exit', () => {
                void cleanupWorktree();
              });
            }

            logger.debug(`[RUNNER RUN] Session webhook timeout for PID ${pid}`);
            logStderrTail();
            resolve({
              type: 'error',
              errorMessage: buildWebhookFailureMessage('timeout')
            });
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

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[RUNNER RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'runner' && session.childProcess) {
            try {
              void killProcessByChildProcess(session.childProcess);
              logger.debug(`[RUNNER RUN] Requested termination for runner-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[RUNNER RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              void killProcess(pid);
              logger.debug(`[RUNNER RUN] Requested termination for external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[RUNNER RUN] Failed to kill external session PID ${pid}:`, error);
            }
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
      pidToAwaiter.delete(pid);
      pidToErrorAwaiter.delete(pid);
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
    // treats as an unknown top-level command - falling back to Claude instead
    // of starting the runner. `getCliArgs()` strips runtime + entrypoint
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
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create();

    const workspaceRoots = resolveWorkspaceRoots(options.workspaceRoots);
    logger.debug(`[RUNNER RUN] Workspace roots: ${workspaceRoots?.join(', ') ?? '(not set)'}`);

    // Get or create machine (with retry for transient connection errors)
    const machine = await withRetry(
      () => api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata({ workspaceRoots }),
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
    console.log(`  Workspace roots: ${workspaceRoots?.join(', ') ?? '(not set — browse disabled; pass --workspace-root to enable)'}`);
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
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isProcessAlive(pid)) {
          logger.debug(`[RUNNER RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
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
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          startedWithCliMtimeMs,
          startedWithApiUrl: fileState.startedWithApiUrl,
          startedWithMachineId: fileState.startedWithMachineId,
          startedWithCliApiTokenHash: fileState.startedWithCliApiTokenHash,
          startedWithExtraHeadersHash: fileState.startedWithExtraHeadersHash,
          startedWithArgv,
          startedWithVersionHandoffDisabled,
          lastHeartbeat: new Date().toLocaleString(),
          runnerLogPath: fileState.runnerLogPath
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
          : agent === 'opencode'
            ? 'opencode'
            : agent === 'pi'
              ? 'pi'
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
  args.push('--hapi-starting-mode', 'remote', '--started-by', 'runner');
  if (agent === 'codex') {
    const existingSessionId = options.existingSessionId ?? options.sessionId;
    if (existingSessionId) {
      args.push('--existing-session-id', existingSessionId);
    }
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort && (agent === 'claude' || agent === 'grok' || agent === 'pi')) {
    args.push('--effort', options.effort);
  }
  if (options.modelReasoningEffort && (agent === 'codex' || agent === 'opencode')) {
    args.push('--model-reasoning-effort', options.modelReasoningEffort);
  }
  if (options.serviceTier && agent === 'codex') {
    args.push('--service-tier', options.serviceTier);
  }
  // Pi RPC mode has no permission switching; never pass these flags to it
  // (the Pi parser rejects --permission-mode and ignores --yolo).
  if (agent !== 'pi') {
    if (options.permissionMode && (PERMISSION_MODES as readonly string[]).includes(options.permissionMode)) {
      args.push('--permission-mode', options.permissionMode);
    } else if (yolo) {
      args.push('--yolo');
    }
  }
  if (agent === 'cursor' && options.sessionType === 'worktree') {
    args.push('--cursor-worktree');
    const name = options.worktreeName?.trim();
    if (name) {
      args.push(name);
    }
  }
  return args;
}
