/**
 * Minimal persistence functions for HAPI CLI
 * 
 * Handles settings, encryption key, and runner state storage in ~/.hapi/ (or HAPI_HOME override)
 */

import { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, readFile, unlink, rename, stat } from 'node:fs/promises'
import { constants, existsSync, writeFileSync, readFileSync, unlinkSync, type Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { configuration } from '@/configuration'
import { isProcessAlive } from '@/utils/process';

interface Settings {
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId?: string
  machineIdConfirmedByServer?: boolean
  runnerAutoStartWhenRunningHappy?: boolean
  cliApiToken?: string
  // API URL for server connections (priority: env HAPI_API_URL > this > default)
  apiUrl?: string
  // Legacy field name (for migration, read-only)
  serverUrl?: string
}

const defaultSettings: Settings = {}
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
// Windows does not expose O_NOFOLLOW. The pre-open, handle, and post-open
// identity checks below are the fallback instead of silently trusting open().
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const NONBLOCK_FLAG = process.platform === 'win32' ? 0 : constants.O_NONBLOCK

function unsafePrivateFile(path: string, reason: string): Error {
  return new Error(`Unsafe private file '${path}': ${reason}`)
}

function assertPrivateRegularFile(path: string, fileStat: Stats): void {
  if (fileStat.isSymbolicLink()) {
    throw unsafePrivateFile(path, 'symbolic links are not allowed')
  }
  if (!fileStat.isFile() || fileStat.nlink !== 1) {
    throw unsafePrivateFile(path, 'expected one regular file link')
  }
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function inspectPrivateFilePath(path: string): Promise<Stats | null> {
  try {
    const pathStat = await lstat(path)
    assertPrivateRegularFile(path, pathStat)
    return pathStat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function openPrivateRegularFile(path: string): Promise<FileHandle | null> {
  const beforeOpen = await inspectPrivateFilePath(path)
  if (!beforeOpen) return null

  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === 'ENOENT') return null
    if (nodeError.code === 'ELOOP') throw unsafePrivateFile(path, 'symbolic links are not allowed')
    throw error
  }

  try {
    const openedFile = await handle.stat()
    assertPrivateRegularFile(path, openedFile)
    const afterOpen = await inspectPrivateFilePath(path)
    if (!afterOpen
      || !isSameFileIdentity(beforeOpen, openedFile)
      || !isSameFileIdentity(openedFile, afterOpen)) {
      throw unsafePrivateFile(path, 'path identity changed while opening')
    }
    await handle.chmod(PRIVATE_FILE_MODE)
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function secureExistingFile(path: string): Promise<void> {
  const handle = await openPrivateRegularFile(path)
  if (handle) {
    await handle.close()
  }
}

async function writePrivateFileAtomically(path: string, contents: string): Promise<void> {
  await secureExistingFile(`${path}.tmp`)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle: FileHandle | null = null
  let renamed = false
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
      PRIVATE_FILE_MODE,
    )
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.writeFile(contents, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
    renamed = true
  } finally {
    await handle?.close().catch(() => {})
    if (!renamed) await unlink(temporary).catch(() => {})
  }
}

/**
 * Runner state persisted locally (different from API RunnerState)
 * This is written to disk by the runner to track its local process state
 */
export interface RunnerLocallyPersistedState {
  pid: number;
  runnerInstanceId?: string;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  startedWithCliMtimeMs?: number;
  startedWithApiUrl?: string;
  startedWithMachineId?: string;
  startedWithCliApiTokenHash?: string;
  lastHeartbeat?: string;
  runnerLogPath?: string;
}

export async function readSettings(): Promise<Settings> {
  await secureExistingFile(`${configuration.settingsFile}.tmp`)
  const handle = await openPrivateRegularFile(configuration.settingsFile)
  if (!handle) {
    return { ...defaultSettings }
  }
  try {
    const content = await handle.readFile({ encoding: 'utf8' })
    return JSON.parse(content)
  } catch {
    return { ...defaultSettings }
  } finally {
    await handle.close()
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  }

  await secureExistingFile(configuration.settingsFile)
  await writePrivateFileAtomically(configuration.settingsFile, JSON.stringify(settings, null, 2))
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  const lockFile = configuration.settingsFile + '.lock';
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // 'wx' = create exclusively, fail if exists (cross-platform compatible)
      fileHandle = await open(lockFile, 'wx', PRIVATE_FILE_MODE);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Write atomically through a private, unpredictable, no-follow file.
    await writePrivateFileAtomically(configuration.settingsFile, JSON.stringify(updated, null, 2));

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Authentication
//

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  }
  await secureExistingFile(configuration.privateKeyFile)
  await writePrivateFileAtomically(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: Buffer.from(credentials.publicKey).toString('base64'), machineKey: Buffer.from(credentials.machineKey).toString('base64') },
    token: credentials.token
  }, null, 2));
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read runner state from local file
 */
export async function readRunnerState(): Promise<RunnerLocallyPersistedState | null> {
  try {
    if (!existsSync(configuration.runnerStateFile)) {
      return null;
    }
    const content = await readFile(configuration.runnerStateFile, 'utf-8');
    return JSON.parse(content) as RunnerLocallyPersistedState;
  } catch (error) {
    // State corrupted somehow :(
    console.error(`[PERSISTENCE] Runner state file corrupted: ${configuration.runnerStateFile}`, error);
    return null;
  }
}

/**
 * Write runner state to local file (synchronously for atomic operation)
 */
export function writeRunnerState(state: RunnerLocallyPersistedState): void {
  writeFileSync(configuration.runnerStateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Clean up runner state file and lock file
 */
export async function clearRunnerState(): Promise<void> {
  if (existsSync(configuration.runnerStateFile)) {
    await unlink(configuration.runnerStateFile);
  }
  // runner.lock is a persistent inode. Ownership is released only by closing
  // the helper's descriptor; cleanup must never unlink or replace it.
}

/**
 * Acquire an exclusive lock file for the runner.
 * The lock file proves the runner is running and prevents multiple instances.
 * Returns the file handle to hold for the runner's lifetime, or null if locked.
 */
export async function acquireRunnerLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 'wx' ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(configuration.runnerLockFile, 'wx');
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.runnerLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            if (!isProcessAlive(Number(lockPid))) {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.runnerLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/** Release legacy ownership by closing its handle. The inode is persistent. */
export async function releaseRunnerLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }
}
