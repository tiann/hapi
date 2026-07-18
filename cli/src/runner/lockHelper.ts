import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs';
import { createInterface } from 'node:readline';
import { readProcessIdentity } from './processIdentity';
import { RUNNER_TIMING } from './runnerConstants';

const INTERNAL_HELPER_ARG = '__hapi_internal_runner_lock_helper_v1';
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type HelperRecord = {
  status: 'ready' | 'locked' | 'query';
  holderPid: number;
  device: number;
  inode: number;
};

export type RunnerLockHelperCommand = {
  executable: string;
  argsPrefix: string[];
};

export interface RunnerLockHandle {
  child: ChildProcessWithoutNullStreams;
  helperPid: number;
  helperBirthToken: string;
  device: number;
  inode: number;
  whenLost: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  assertHealthy(): void;
  close(): Promise<void>;
}

function libcPath(): string {
  if (process.platform === 'darwin') return '/usr/lib/libSystem.B.dylib';
  if (process.platform === 'linux') return 'libc.so.6';
  throw new Error(`runner kernel lock is unavailable on ${process.platform}`);
}

async function withFlock<T>(fn: (flock: (fd: number, operation: number) => number) => T): Promise<T> {
  const specifier = 'bun:ffi';
  const { dlopen, FFIType } = await import(specifier) as typeof import('bun:ffi');
  const libc = dlopen(libcPath(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  });
  try {
    return fn(libc.symbols.flock);
  } finally {
    libc.close();
  }
}

function openLock(path: string): number {
  return openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
}

function readHolderPid(fd: number): number {
  try {
    const value = readFileSync(fd, 'utf8').trim();
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function recordFor(fd: number, status: HelperRecord['status'], holderPid: number): HelperRecord {
  const stat = fstatSync(fd, { bigint: false });
  return { status, holderPid, device: stat.dev, inode: stat.ino };
}

function emitRecord(record: HelperRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Internal child-process entrypoint. It holds a kernel flock until stdin closes. */
export async function runRunnerLockHelperProcess(args: string[]): Promise<number> {
  const [mode, lockPath] = args;
  if ((mode !== 'hold' && mode !== 'query') || !lockPath) return 64;

  // An interactive Ctrl-C/terminal stop is delivered to the whole foreground
  // process group. The Runner owns graceful shutdown; the helper must keep the
  // kernel lock until the parent's stdin closes, otherwise cleanup loses its
  // ownership proof midway through shutdown.
  const deferParentSignal = () => {};
  if (mode === 'hold') {
    process.on('SIGINT', deferParentSignal);
    process.on('SIGTERM', deferParentSignal);
  }

  const fd = openLock(lockPath);
  try {
    if (mode === 'query') {
      return await withFlock((flock) => {
        if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
          emitRecord(recordFor(fd, 'query', 0));
          flock(fd, LOCK_UN);
        } else {
          emitRecord(recordFor(fd, 'query', readHolderPid(fd)));
        }
        return 0;
      });
    }

    const acquired = await withFlock((flock) => flock(fd, LOCK_EX | LOCK_NB) === 0);
    if (!acquired) {
      emitRecord(recordFor(fd, 'locked', readHolderPid(fd)));
      return 2;
    }

    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`, 0, 'utf8');
    fsyncSync(fd);
    emitRecord(recordFor(fd, 'ready', process.pid));

    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      process.stdin.once('end', finish);
      process.stdin.once('close', finish);
      process.stdin.resume();
    });
    await withFlock((flock) => flock(fd, LOCK_UN));
    return 0;
  } finally {
    if (mode === 'hold') {
      process.off('SIGINT', deferParentSignal);
      process.off('SIGTERM', deferParentSignal);
    }
    closeSync(fd);
  }
}

export function isRunnerLockHelperInvocation(argv: string[] = process.argv): boolean {
  return argv.includes(INTERNAL_HELPER_ARG);
}

export async function runRunnerLockHelperInvocation(argv: string[] = process.argv): Promise<number> {
  const index = argv.indexOf(INTERNAL_HELPER_ARG);
  return runRunnerLockHelperProcess(argv.slice(index + 1));
}

function defaultHelperCommand(): RunnerLockHelperCommand {
  const entrypoint = process.argv[1];
  const sourceMode = typeof entrypoint === 'string' && /\.(?:[cm]?[jt]s|tsx)$/.test(entrypoint);
  return {
    executable: process.execPath,
    argsPrefix: sourceMode ? [entrypoint, INTERNAL_HELPER_ARG] : [INTERNAL_HELPER_ARG]
  };
}

function parseRecord(line: string): HelperRecord {
  const parsed = JSON.parse(line) as Partial<HelperRecord>;
  if (!parsed.status || !Number.isInteger(parsed.holderPid) || !Number.isFinite(parsed.device) || !Number.isFinite(parsed.inode)) {
    throw new Error(`invalid runner lock helper response: ${line}`);
  }
  return parsed as HelperRecord;
}

async function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  const lines = createInterface({ input: child.stdout });
  return await new Promise((resolveLine, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error('runner lock helper readiness timed out'));
    }, RUNNER_TIMING.lockDeadlineMs);
    timeout.unref();
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`runner lock helper exited before ready (${code})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`runner lock helper failed to start: ${error.message}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      lines.close();
    };
    child.once('exit', onExit);
    child.once('error', onError);
    lines.once('line', (line) => {
      cleanup();
      resolveLine(line);
    });
  });
}

async function waitForSuccessfulExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`runner lock query failed (${child.exitCode})`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      child.off('exit', onExit);
      reject(error);
    };
    const onExit = (code: number | null) => {
      child.off('error', onError);
      code === 0 ? resolve() : reject(new Error(`runner lock query failed (${code})`));
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit);
      resolve();
    }
  });
}

export async function startRunnerLockHelper(opts: {
  lockPath: string;
  command?: RunnerLockHelperCommand;
}): Promise<RunnerLockHandle> {
  const command = opts.command ?? defaultHelperCommand();
  const child = spawn(command.executable, [...command.argsPrefix, 'hold', opts.lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const record = parseRecord(await firstLine(child));
  if (record.status !== 'ready') {
    child.stdin.end();
    throw new Error(`runner lock is already locked by helper ${record.holderPid}`);
  }
  const identity = await readProcessIdentity(child.pid!);
  if (!identity) {
    child.stdin.end();
    throw new Error('runner lock helper identity unavailable');
  }

  let closing = false;
  let lost = false;
  let resolveLost!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const whenLost = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveLost = resolve; });
  child.once('exit', (code, signal) => {
    lost = true;
    if (!closing) resolveLost({ code, signal });
  });

  const assertHealthy = () => {
    if (lost || child.exitCode !== null || child.signalCode !== null) throw new Error('runner kernel lock owner exited');
    const current = lstatSync(opts.lockPath, { bigint: false });
    if (current.dev !== record.device || current.ino !== record.inode) {
      throw new Error('runner kernel lock path inode changed');
    }
  };
  assertHealthy();

  return {
    child,
    helperPid: child.pid!,
    helperBirthToken: identity.birthToken,
    device: record.device,
    inode: record.inode,
    whenLost,
    assertHealthy,
    close: async () => {
      if (closing) return;
      closing = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await waitForExit(child);
    }
  };
}

export async function queryRunnerLock(opts: {
  lockPath: string;
  command?: RunnerLockHelperCommand;
}): Promise<{ locked: boolean; holderPid: number; device: number; inode: number }> {
  const command = opts.command ?? defaultHelperCommand();
  const child = spawn(command.executable, [...command.argsPrefix, 'query', opts.lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  const line = await firstLine(child);
  const record = parseRecord(line);
  await waitForSuccessfulExit(child);
  return { locked: record.holderPid > 0, holderPid: record.holderPid, device: record.device, inode: record.inode };
}
