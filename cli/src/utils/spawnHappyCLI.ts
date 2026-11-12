/**
 * Cross-platform HAPI CLI spawning utility
 *
 * ## Background
 *
 * HAPI CLI runs in two modes:
 * 1. **Compiled binary**: A single executable built with `bun build --compile`
 * 2. **Development mode**: Running TypeScript directly via `bun`
 *
 * ## Execution Modes
 *
 * **Compiled Binary (Production):**
 * - The executable is self-contained and runs directly
 * - `process.execPath` points to the compiled binary itself
 * - No additional entrypoint needed - just pass args to `process.execPath`
 *
 * **Development Mode:**
 * - Running via `bun src/index.ts`
 * - Spawn child processes using the same runtime with `src/index.ts` entrypoint
 *
 * ## Cross-Platform Support
 *
 * This utility handles spawning HAPI CLI subprocesses (for runner processes)
 * in a cross-platform way, detecting the current runtime mode and using
 * the appropriate command and arguments.
 */

import { spawn, spawnSync, SpawnOptions, type ChildProcess } from 'child_process';
import { join, isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBunCompiled, projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { DISCLAIM_RESPONSIBILITY_ENV, shouldDisclaimResponsibility } from '@/runtime/disclaimExec';
import { canDisclaimForChildren } from '@/runtime/responsibility';

const HAPI_CLI_EXECUTABLE_ENV = 'HAPI_CLI_EXECUTABLE';

// Bun-compiled HAPI binaries die during runtime init (before any JS runs) when
// the inherited RLIMIT_NOFILE soft limit is low. Launch Services (launchd)
// defaults the soft limit to 2560/10240, so every child spawned from a
// runner that launchd (or a launchd-spawned guard) started crashes at startup
// with "error: An unknown error occurred (Unexpected)" and never writes a log.
// Bun has no process.setrlimit and the child dies pre-JS, so the only fix is
// raising the limit in the parent before exec: wrap the spawn in a tiny
// /bin/sh that bumps the soft limit, then execs the real command (exec keeps
// signals/stdio/pid semantics identical).
export const NOFILE_BUMP_THRESHOLD = 65536;
const NOFILE_BUMP_TARGET = 1048576;

let cachedNofileSoft: number | undefined;
let cachedNofileHard: number | undefined;

function probeUlimitLimit(flag: '-Sn' | '-Hn'): number {
  try {
    const result = spawnSync('/bin/sh', ['-c', `ulimit ${flag}`], {
      encoding: 'utf8',
      timeout: 5000
    });
    if (result.status === 0) {
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    // Fall through — NaN is treated as "unknown".
  }
  return Number.NaN;
}

export function getNofileSoftLimit(): number {
  if (cachedNofileSoft === undefined) {
    cachedNofileSoft = probeUlimitLimit('-Sn');
  }
  return cachedNofileSoft;
}

function getNofileHardLimit(): number {
  if (cachedNofileHard === undefined) {
    // "unlimited" (and any non-numeric output) parses to NaN — "unknown".
    cachedNofileHard = probeUlimitLimit('-Hn');
  }
  return cachedNofileHard;
}

/**
 * Wrap a spawn command in `/bin/sh -c 'ulimit -n <target>; exec "$@"'` when the
 * inherited RLIMIT_NOFILE soft limit is low enough to crash Bun-compiled
 * binaries. Returns the command unchanged on Windows, when the soft limit is
 * already comfortable (or unknown), or when it cannot be raised.
 *
 * The raise target is clamped to the inherited hard limit: as a non-root
 * process `ulimit -n` cannot exceed the hard cap ("Operation not permitted"),
 * which would silently no-op the mitigation. When the hard limit cannot be
 * probed, the fixed target is used and the shell failure is swallowed so the
 * child still launches.
 *
 * `platform`, `softLimit`, and `hardLimit` are injectable for tests.
 */
export function applyNofileBump(
  command: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; softLimit?: number; hardLimit?: number } = {}
): HappyCliCommand {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    return { command, args };
  }
  const softLimit = opts.softLimit ?? getNofileSoftLimit();
  if (!Number.isFinite(softLimit) || softLimit >= NOFILE_BUMP_THRESHOLD) {
    return { command, args };
  }
  let target = NOFILE_BUMP_TARGET;
  const hardLimit = opts.hardLimit ?? getNofileHardLimit();
  if (Number.isFinite(hardLimit)) {
    if (hardLimit <= softLimit) {
      // The soft limit cannot be raised at all — wrapping would only add a
      // shell hop without changing the outcome.
      return { command, args };
    }
    target = Math.min(target, hardLimit);
  }
  // `sh -c <script> <argv0> <cmd> <args...>`: the first arg after the script
  // string becomes $0, so `"$@"` starts at the real command. Without `-c` sh
  // would treat the script string as a file name and fail with exit 127;
  // without the $0 placeholder `exec "$@"` would drop the real command.
  return {
    command: '/bin/sh',
    args: ['-c', `ulimit -n ${target} 2>/dev/null; exec "$@"`, 'sh', command, ...args]
  };
}

/**
 * Resolve the TypeScript entrypoint for development mode.
 */
function resolveEntrypoint(projectRoot: string): string {
  const srcEntrypoint = join(projectRoot, 'src', 'index.ts');
  if (existsSync(srcEntrypoint)) {
    return srcEntrypoint;
  }

  throw new Error('No CLI entrypoint found (expected src/index.ts)');
}

export interface HappyCliCommand {
  command: string;
  args: string[];
}

function isCrossPlatformAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function resolveInvokedCwd(cwd: SpawnOptions['cwd']): string {
  if (cwd instanceof URL) {
    return fileURLToPath(cwd);
  }

  if (typeof cwd === 'string' && cwd.trim().length > 0) {
    const normalizedCwd = cwd.trim();
    return isCrossPlatformAbsolutePath(normalizedCwd) ? normalizedCwd : resolve(normalizedCwd);
  }

  const inheritedInvokedCwd = process.env.HAPI_INVOKED_CWD?.trim();
  if (inheritedInvokedCwd && isCrossPlatformAbsolutePath(inheritedInvokedCwd)) {
    return inheritedInvokedCwd;
  }

  return process.cwd();
}

export function resolveHappyCliExecutable(): string {
  const override = process.env[HAPI_CLI_EXECUTABLE_ENV]?.trim();
  if (override && isCrossPlatformAbsolutePath(override) && existsSync(override)) {
    return override;
  }

  const argv0 = process.argv[0]?.trim();
  if (argv0 && isCrossPlatformAbsolutePath(argv0) && existsSync(argv0)) {
    return argv0;
  }

  const bunArgv0 = globalThis.Bun?.argv?.[0]?.trim();
  if (bunArgv0 && isCrossPlatformAbsolutePath(bunArgv0) && existsSync(bunArgv0)) {
    return bunArgv0;
  }

  return process.execPath;
}

export function getHappyCliCommand(args: string[]): HappyCliCommand {
  // Compiled binary mode: just use the executable directly
  if (isBunCompiled()) {
    return {
      command: resolveHappyCliExecutable(),
      args
    };
  }

  // Development mode: spawn with TypeScript entrypoint
  const projectRoot = projectPath();
  const entrypoint = resolveEntrypoint(projectRoot);
  const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

  if (isBunRuntime) {
    // Bun can run TypeScript directly.
    // Force Bun's cwd to the CLI project root so alias resolution via bunfig.toml
    // keeps working even when external tools launch HAPI from another workspace.
    return {
      command: process.execPath,
      args: ['--cwd', projectRoot, entrypoint, ...args]
    };
  }

  // When vitest runs under Node.js, HAPI_BUN_EXEC can point to the bun binary so that
  // spawned CLI child processes still run under bun (which is required for TypeScript entrypoints).
  const bunExecOverride = process.env['HAPI_BUN_EXEC']?.trim();
  if (bunExecOverride && isCrossPlatformAbsolutePath(bunExecOverride) && existsSync(bunExecOverride)) {
    return {
      command: bunExecOverride,
      args: ['--cwd', projectRoot, entrypoint, ...args]
    };
  }

  // Node.js fallback: preserve execArgv (for compatibility)
  return {
    command: process.execPath,
    args: [...process.execArgv, entrypoint, ...args]
  };
}

export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're executing the current runtime with the calculated entrypoint path below,
  // bypassing the 'hapi' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'hapi' here because other engineers are typically looking
  // for when "hapi" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `hapi ${args.join(' ')}`;
  // A detached process outlives its spawner. On macOS, when the spawner's
  // responsible process goes away with it (launchd-managed runner, or its npm
  // launcher), the child must not keep it (see runtime/disclaimExec.ts).
  const disclaimResponsibility = shouldDisclaimResponsibility(process.platform, options.detached, canDisclaimForChildren);
  logger.debug(`[SPAWN HAPI CLI] Spawning: ${fullCommand} in ${directory}${disclaimResponsibility ? ' (macOS responsibility disclaim requested)' : ''}`);

  const compiledMode = isBunCompiled();
  const { command: spawnCommand, args: spawnArgs } = getHappyCliCommand(args);

  // Sanity check that the entrypoint path exists
  if (!compiledMode) {
    const entrypoint = spawnArgs.find((arg) => arg.endsWith('index.ts'));
    if (entrypoint && !existsSync(entrypoint)) {
      const errorMessage = `Entrypoint ${entrypoint} does not exist`;
      logger.debug(`[SPAWN HAPI CLI] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
  
  // On Windows, detached processes allocate a new console window by default.
  // windowsHide: true suppresses this to prevent cmd windows from accumulating.
  const finalOptions: SpawnOptions = { ...options };
  const finalEnv = { ...process.env, ...options.env };
  let shouldSetEnv = false;
  if (compiledMode) {
    finalEnv[HAPI_CLI_EXECUTABLE_ENV] = spawnCommand;
    shouldSetEnv = true;
  } else {
    const invokedCwd = finalEnv.HAPI_INVOKED_CWD?.trim();
    const hasExplicitCwd = 'cwd' in options && options.cwd !== undefined;
    finalEnv.HAPI_INVOKED_CWD = hasExplicitCwd
      ? resolveInvokedCwd(options.cwd)
      : invokedCwd && isCrossPlatformAbsolutePath(invokedCwd)
        ? invokedCwd
        : resolveInvokedCwd(options.cwd);
    shouldSetEnv = true;
  }
  // Set or cleared explicitly so an inherited request never leaks to a child.
  if (disclaimResponsibility) {
    finalEnv[DISCLAIM_RESPONSIBILITY_ENV] = String(process.pid);
  } else {
    delete finalEnv[DISCLAIM_RESPONSIBILITY_ENV];
  }
  if (shouldSetEnv) {
    finalOptions.env = finalEnv;
  }
  if (process.platform === 'win32' && options.detached) {
    finalOptions.windowsHide = true;
  }
  // Only Bun-compiled binaries crash at low RLIMIT_NOFILE (plain `bun` runs
  // fine) — dev-mode spawns keep their direct command line.
  // Applied after the env assembly above so HAPI_CLI_EXECUTABLE keeps pointing
  // at the real hapi binary even when the exec line is wrapped.
  const bumped = compiledMode ? applyNofileBump(spawnCommand, spawnArgs) : { command: spawnCommand, args: spawnArgs };
  return spawn(bumped.command, bumped.args, finalOptions);
}
