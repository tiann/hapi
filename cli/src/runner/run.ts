import fs from 'fs/promises';
import os from 'os';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { RunnerState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeRunnerState, RunnerLocallyPersistedState, readRunnerState, acquireRunnerLock, releaseRunnerLock } from '@/persistence';
import { isProcessAlive, isWindows, killProcess, killProcessByChildProcess } from '@/utils/process';
import { withRetry } from '@/utils/time';
import { isRetryableConnectionError } from '@/utils/errorUtils';

import { cleanupRunnerState, getInstalledCliMtimeMs, isRunnerRunningCurrentlyInstalledHappyVersion, stopRunner } from './controlClient';
import { startRunnerControlServer } from './controlServer';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktree';
import { join } from 'path';
import { buildMachineMetadata } from '@/agent/sessionFactory';

export async function startRunner(): Promise<void> {
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

  // Capture CLI mtime at startup for hot reload detection
  const startedWithCliMtimeMs = getInstalledCliMtimeMs();

  // Optional: SIGUSR1 handler for immediate version check and reload
  // This allows install.sh to trigger instant reload via: kill -USR1 <pid>
  if (!isWindows()) {
    process.on('SIGUSR1', () => {
      logger.debug('[RUNNER RUN] Received SIGUSR1 - triggering immediate version check');
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[RUNNER RUN] Version mismatch detected via SIGUSR1, triggering reload');
        console.log('[RUNNER] Binary update detected via signal - initiating immediate reload');
        requestShutdown('os-signal', 'Binary updated - hot reload triggered via SIGUSR1');
      } else {
        logger.debug('[RUNNER RUN] SIGUSR1 received but binary is up to date');
      }
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

  // Acquire exclusive lock (proves runner is running)
  const runnerLockHandle = await acquireRunnerLock(5, 200);
  if (!runnerLockHandle) {
    logger.debug('[RUNNER RUN] Runner lock file already held, another runner is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the runner:
  // 1. Not have a stale runner state
  // 2. Should not have another runner process running

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[RUNNER RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

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
          awaiter(existingSession);
          logger.debug(`[RUNNER RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
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
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[RUNNER RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true, resumeSessionId, forkSession } = options;
      const agent = options.agent ?? 'claude';
      const yolo = options.yolo === true;
      const sessionType = options.sessionType ?? 'simple';
      const worktreeName = options.worktreeName;
      let directoryCreated = false;
      let spawnDirectory = directory;
      let worktreeInfo: WorktreeInfo | null = null;
      let happyProcess: ReturnType<typeof spawnHappyCLI> | null = null;

      if (sessionType === 'simple') {
        try {
          await fs.access(directory);
          logger.debug(`[RUNNER RUN] Directory exists: ${directory}`);
        } catch (error) {
          logger.debug(`[RUNNER RUN] Directory doesn't exist, creating: ${directory}`);

          // Check if directory creation is approved
          if (!approvedNewDirectoryCreation) {
            logger.debug(`[RUNNER RUN] Directory creation not approved for: ${directory}`);
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
          return {
            type: 'error',
            errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`
          };
        }
      }

      if (sessionType === 'worktree') {
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

        // Construct arguments for the CLI
        const agentCommand = agent === 'codex'
          ? 'codex'
          : agent === 'gemini'
            ? 'gemini'
            : 'claude';
        const args = [
          agentCommand,
          '--hapi-starting-mode', 'remote',
          '--started-by', 'runner'
        ];

        // Pass hapi session ID if provided (for resuming existing sessions)
        if (sessionId) {
          args.push('--hapi-session-id', sessionId);
        }

        // Pass session ID to resume if provided (unified flag for all agents)
        if (resumeSessionId) {
          args.push('--resume-session', resumeSessionId);
        }

        // Pass fork flag if specified (Claude only)
        if (forkSession && agent === 'claude') {
          args.push('--fork-session');
        }

        if (options.model) {
          args.push('--model', options.model);
        }
        if (yolo) {
          args.push('--yolo');
        }
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

        if (!happyProcess.pid) {
          logger.debug('[RUNNER RUN] Failed to spawn process - no PID returned');
          await maybeCleanupWorktree('no-pid');
          return {
            type: 'error',
            errorMessage: 'Failed to spawn HAPI process - no PID returned'
          };
        }

        const pid = happyProcess.pid;
        logger.debug(`[RUNNER RUN] Spawned process with PID ${pid}`);

        const trackedSession: TrackedSession = {
          startedBy: 'runner',
          pid,
          childProcess: happyProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };

        pidToTrackedSession.set(pid, trackedSession);

        happyProcess.on('exit', (code, signal) => {
          logger.debug(`[RUNNER RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
          if (code !== 0 || signal) {
            logStderrTail();
          }
          onChildExited(pid);
        });

        happyProcess.on('error', (error) => {
          logger.debug(`[RUNNER RUN] Child process error:`, error);
          onChildExited(pid);
        });

        // Wait for webhook to populate session with happySessionId
        logger.debug(`[RUNNER RUN] Waiting for session webhook for PID ${pid}`);

        const spawnResult = await new Promise<SpawnSessionResult>((resolve) => {
          // Set timeout for webhook
          const timeout = setTimeout(() => {
            pidToAwaiter.delete(pid);
            logger.debug(`[RUNNER RUN] Session webhook timeout for PID ${pid}`);
            logStderrTail();
            resolve({
              type: 'error',
              errorMessage: `Session webhook timeout for PID ${pid}`
            });
            // 15 second timeout - I have seen timeouts on 10 seconds
            // even though session was still created successfully in ~2 more seconds
          }, 15_000);

          // Register awaiter
          pidToAwaiter.set(pid, (completedSession) => {
            clearTimeout(timeout);
            logger.debug(`[RUNNER RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            resolve({
              type: 'success',
              sessionId: completedSession.happySessionId!
            });
          });
        });
        if (spawnResult.type !== 'success') {
          await maybeCleanupWorktree('spawn-error');
        }
        return spawnResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[RUNNER RUN] Failed to spawn session:', error);
        await maybeCleanupWorktree('exception');
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    // Get process by session ID
    const getProcessBySessionId = (sessionId: string): any | null => {
      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId) {
          return session.childProcess || null;
        }
      }
      return null;
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
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startRunnerControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('hapi-cli'),
      onHappySessionWebhook
    });

    // Write initial runner state (no lock needed for state file)
    const fileState: RunnerLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
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
        metadata: buildMachineMetadata(),
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
      stopSession,
      requestShutdown: () => requestShutdown('hapi-app'),
      getProcessBySessionId
    });

    // Connect to server
    apiMachine.connect();

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

      // Check if runner needs update
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[RUNNER RUN] Binary update detected - initiating hot reload');
        logger.debug(`[RUNNER RUN] Current binary mtime: ${installedCliMtimeMs}, started with: ${startedWithCliMtimeMs}`);

        // Log to stdout so it appears in journalctl for systemd visibility
        console.log('[RUNNER] Binary updated - initiating hot reload');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new runner through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if runner is running (yes in this case)
        // 2. If the version is stale (it will read runner.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new runner with the latest version with runner-sync :D
        // Done!
        try {
          spawnHappyCLI(['runner', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
          logger.debug('[RUNNER RUN] New runner spawned successfully');
        } catch (error) {
          logger.debug('[RUNNER RUN] Failed to spawn new runner, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // Wait briefly to ensure new runner starts and acquires lock
        logger.debug('[RUNNER RUN] Waiting 2 seconds for new runner to acquire lock before exit');
        await new Promise(resolve => setTimeout(resolve, 2_000));

        logger.debug('[RUNNER RUN] Exiting to complete hot reload - systemd will restart service with new binary');
        console.log('[RUNNER] Hot reload complete - exiting');
        process.exit(0);
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
